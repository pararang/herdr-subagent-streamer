#!/usr/bin/env node
// herdr-subagent-streamer: one multiplexer tab per session's subagents, in one of three stream modes:
//   hybrid (default) graph plus reusable active-worker splits; tail board plus active-worker splits;
//   graph  one pane drawing the agent flow graph
//   streamer.mjs auto  <cfg>    watch this session's subagents; open the tab (and splits in hybrid/tail mode)
//   streamer.mjs board <cfg>    status list (root pane of the tab in tail mode)
//   streamer.mjs graph <cfg>    flow graph (root pane of the tab in hybrid/graph mode)
//   streamer.mjs follow <assignment>  pretty-tail one assigned subagent until it becomes inactive
// Arguments are base64url JSON; the extension builds cfg, auto builds follower assignments.
// Mux: herdr when HERDR_ENV=1, else tmux when $TMUX is set (override: HERDR_SUBAGENT_STREAMER_MUX).
// Node >= 18 or bun; no dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TERMINAL, foldFeed, hostFor, resolve } from "./hosts.mjs";
import { loadConfig } from "./config.mjs";
import { MAIN, buildGraph, createActivity, render } from "./graph.mjs";

const SELF = `${q(process.execPath)} ${q(fileURLToPath(import.meta.url))}`;
const CLOSE_AFTER_MS = Number(process.env.HERDR_SUBAGENT_STREAMER_CLOSE_MS ?? 5000); // 0 keeps the tab open
const ACTIVE_STATUSES = ["started", "running"];
const FOLLOW_POLL_MS = 400;
const AUTO_POLL_MS = 1000;
const FOLLOW_START_TIMEOUT_MS = 10000;
const RESET_TRANSCRIPT = "\x1b[3J\x1b[H\x1b[2J";
const IDLE_SHELL_COMMAND = "exec /bin/sh";
const mux = process.env.HERDR_SUBAGENT_STREAMER_MUX ?? (process.env.HERDR_ENV === "1" ? "herdr" : process.env.TMUX ? "tmux" : "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s).replace(/\s+/g, " ");
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const dec = (s) => JSON.parse(Buffer.from(s, "base64url").toString());
function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
const isActive = (status) => ACTIVE_STATUSES.includes(status);
const flush = (text = "") => new Promise((ok, fail) => process.stdout.write(text, (err) => err ? fail(err) : ok()));
const readReceipt = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
function receipt(assignment, phase, details = {}) {
  const file = assignment.receiptPath;
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ token: assignment.token, pid: process.pid, phase, ...details }));
  fs.renameSync(`${file}.tmp`, file);
}

// ---------- follow: pretty-tail one transcript ----------
async function follow(assignment) {
  const { spec, paneId, label, hostPid, backend } = assignment;
  let done = 0, file;
  const drain = (transcript) => {
    if (!transcript || !fs.existsSync(transcript)) return;
    if (file !== transcript) { file = transcript; done = 0; }
    const lines = fs.readFileSync(transcript, "utf8").split("\n");
    lines.pop(); // A partial JSONL record still waits for its newline, including at completion.
    for (let i = done; i < lines.length; i++) print(lines[i]);
    done = lines.length;
  };
  receipt(assignment, "started");
  try {
    await flush(RESET_TRANSCRIPT);
    if (backend === "herdr") run("herdr", ["pane", "rename", paneId, label]);
    else {
      run("tmux", ["clear-history", "-t", paneId]);
      run("tmux", ["select-pane", "-t", paneId, "-T", label]);
    }
    console.log(C(1, `== ${label} ==`));
    while (true) {
      const { status, transcript } = resolve(spec);
      drain(transcript);
      const hostGone = spec.host === "omp" && hostPid && !alive(hostPid);
      if (!isActive(status) || hostGone) {
        // Preserve the existing final complete-record pass, not an unbounded late-write promise.
        drain(resolve(spec).transcript);
        console.log(C(1, `== ${hostGone ? "host exited" : status ?? "inactive"} ==`));
        await flush();
        receipt(assignment, "drained", { transcript: file, lines: done });
        return;
      }
      await sleep(FOLLOW_POLL_MS);
    }
  } catch (error) {
    receipt(assignment, "failed", { error: error.message });
    throw error;
  }
}

function print(line) {
  let e; try { e = JSON.parse(line); } catch { return; }
  const m = e.message; if (e.type !== "message" || !m) return;
  for (const c of Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]) {
    if (m.role === "user" && c.type === "text") console.log(C(35, "PROMPT ") + clip(c.text, 500));
    else if (c.type === "thinking") console.log(C(2, "~ " + clip(c.thinking ?? "", 300)));
    else if (c.type === "text" && m.role === "assistant") console.log(C(32, c.text));
    else if (c.type === "toolCall") console.log(C(36, `> ${c.name} `) + clip(JSON.stringify(c.arguments ?? {}), 240));
    else if (m.role === "toolResult" && c.type === "text") console.log((m.isError ? C(31, "! ") : C(2, "< ")) + clip(c.text, 300));
  }
}

// ---------- board ----------
const GLYPH = { running: C(33, "*"), started: C(33, "*"), completed: C(32, "+"), failed: C(31, "x"), aborted: C(31, "x"), cancelled: C(31, "x") };

async function board(cfg) {
  const host = hostFor(cfg);
  while (true) {
    const out = [C(1, "subagents ") + C(2, String(cfg.session ?? "").slice(0, 8)), ""];
    for (const t of host.list()) {
      const end = Date.parse(t.ended ?? "") || Date.now();
      const secs = Math.round((end - Date.parse(t.started ?? t.created)) / 1000);
      out.push(`  ${GLYPH[t.status] ?? C(2, ".")} ${t.name.padEnd(16)} ${String(t.status).padEnd(10)} ${C(2, t.id)} ${String(secs).padStart(4)}s  ${C(2, t.category)}`);
    }
    process.stdout.write("\x1b[H\x1b[2J" + out.join("\n") + "\n");
    await sleep(1000);
  }
}

// ---------- graph ----------
async function graph(cfg) {
  const host = hostFor(cfg), acts = new Map();
  const track = (id, file) => {
    if (!file) return;
    let a = acts.get(id);
    if (a?.file !== file) acts.set(id, (a = createActivity(file)));
    a.poll();
  };
  process.stdout.write("\x1b[?25l");
  process.on("exit", () => process.stdout.write("\x1b[?25h"));
  process.on("SIGTERM", () => process.exit(0));
  const title = String(cfg.session ?? "").slice(0, 8);
  let g;
  for (let frame = 0; ; frame++) {
    if (frame % 4 === 0) {
      const tasks = host.list();
      track(MAIN, foldFeed(cfg.feed).sessionFile);
      for (const t of tasks) track(t.id, resolve(t.spec).transcript);
      g = buildGraph({ session: cfg.session, tasks, acts });
    }
    const lines = render(g, { cols: process.stdout.columns || 100, rows: process.stdout.rows || 30, frame, title });
    process.stdout.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
    await sleep(250);
  }
}

// ---------- multiplexer ----------
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || r.error || "").toString().trim()}`);
  return r.stdout.trim();
};
const hj = (...a) => JSON.parse(run("herdr", a)).result;

// Name of the tab/window the main agent runs in; the subagents tab is named after it.
const mainTabLabel = () => (mux === "herdr" ? hj("tab", "get", process.env.HERDR_TAB_ID ?? "").tab.label : run("tmux", ["display", "-p", "-t", process.env.TMUX_PANE ?? "", "#{window_name}"]));

// Returns the root pane id and a handle for closeTab (herdr tab id / tmux pane id, whose window gets killed).
function openTab(label, cmd) {
  if (mux === "herdr") {
    const r = hj("tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID ?? "", "--label", label, "--no-focus");
    try {
      run("herdr", ["pane", "run", r.root_pane.pane_id, cmd]);
      return { pane: r.root_pane.pane_id, tab: r.tab.tab_id };
    } catch (error) {
      try { closeTab(r.tab.tab_id); }
      catch (cleanupError) { console.error(`tab cleanup failed: ${cleanupError.message}`); }
      throw error;
    }
  }
  const pane = run("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", label, cmd]);
  return { pane, tab: pane };
}

// Split off `from`; alternate right/down so a fan-out stays a grid. Returns the new pane id.
function openPane(from, i) {
  if (mux === "herdr") {
    return hj("pane", "split", from, "--direction", i % 2 ? "right" : "down", "--no-focus", "--cwd", process.cwd()).pane.pane_id;
  }
  return run("tmux", ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", from, IDLE_SHELL_COMMAND]);
}

function startPane(slot, assignment) {
  const cmd = `${SELF} follow ${enc(assignment)}`;
  const initialShell = slot.initialShell;
  if (mux === "tmux" && initialShell) {
    run("tmux", ["set-option", "-p", "-t", slot.paneId, "remain-on-exit", "on"]);
    try { run("tmux", ["set-option", "-p", "-t", slot.paneId, "remain-on-exit-format", ""]); }
    catch (error) { console.error(`pane status format unavailable: ${error.message}`); }
    run("tmux", ["select-layout", "-t", slot.paneId, "tiled"]);
  }
  slot.initialShell = false;
  if (mux === "herdr") run("herdr", ["pane", "run", slot.paneId, cmd]);
  else run("tmux", ["respawn-pane", ...(initialShell ? ["-k"] : []), "-t", slot.paneId, cmd]);
}

const closeTab = (tab) => (mux === "herdr" ? run("herdr", ["tab", "close", tab]) : run("tmux", ["kill-window", "-t", tab]));
const closePane = (pane) => (mux === "herdr" ? run("herdr", ["pane", "close", pane]) : run("tmux", ["kill-pane", "-t", pane]));
function checkPane(pane) {
  if (mux === "herdr") return hj("pane", "get", pane);
  const found = run("tmux", ["display", "-p", "-t", pane, "#{pane_id}"]);
  if (found !== pane) throw new Error(`pane ${pane} not found`);
  return found;
}
const checkTab = (tab) => (mux === "herdr" ? hj("tab", "get", tab) : checkPane(tab));

const MODES = {
  hybrid: { root: "graph", transcripts: true },
  tail: { root: "board", transcripts: true },
  graph: { root: "graph", transcripts: false },
};

// ---------- auto ----------
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function auto(cfg) {
  if (!mux) throw new Error("needs herdr (HERDR_ENV=1) or tmux ($TMUX)");
  const host = hostFor(cfg);
  const { streamMode } = loadConfig();
  const mode = MODES[streamMode];
  const observed = new Map();
  let tab = "", rootPane = "", slots = [], peakActive = 0, allDoneAt = 0, openRequested = false, receiptDir;
  const forgetTab = () => {
    for (const slot of slots) if (slot.assignment) fs.rmSync(slot.assignment.receiptPath, { force: true });
    tab = rootPane = ""; slots = []; peakActive = 0; allDoneAt = 0;
  };
  process.on("exit", () => { if (receiptDir) fs.rmSync(receiptDir, { recursive: true, force: true }); });
  process.on("SIGTERM", () => { try { if (tab) closeTab(tab); } finally { process.exit(0); } });
  console.log(`streamer (${mux}, ${cfg.host}, ${streamMode}, session ${String(cfg.session).slice(0, 8)}): waiting for subagents`);
  for (let first = true; ; first = false) {
    for (const slot of [...slots]) {
      const a = slot.assignment;
      if (!a) continue;
      const r = readReceipt(a.receiptPath);
      const matches = r?.token === a.token;
      if (matches && alive(r.pid)) continue;
      if (matches && r.phase === "drained") {
        fs.rmSync(a.receiptPath, { force: true });
        slot.lastId = a.task.id;
        slot.assignment = null;
        continue;
      }
      if (!matches && Date.now() - a.launchedAt < FOLLOW_START_TIMEOUT_MS) continue;
      console.error(`follower failed for ${a.task.id}: ${matches ? r.error ?? "exited without final drain" : "startup receipt missing"}`);
      // A failed drain is not reusable. Destroy its pane instead of handing its output to another task.
      try { closePane(slot.paneId); }
      catch (error) {
        try { checkPane(slot.paneId); console.error(`pane cleanup failed: ${error.message}`); continue; }
        catch {}
      }
      fs.rmSync(a.receiptPath, { force: true });
      slots.splice(slots.indexOf(slot), 1);
    }
    const tasks = host.list();
    const hostGone = cfg.pid && !alive(cfg.pid);
    // OMP workers die with their host; detached OMO workers may outlive it.
    const settled = (t) => TERMINAL.includes(t.status) || (hostGone && cfg.host === "omp");
    const active = tasks.filter((t) => isActive(t.status) && !settled(t));
    const wake = tasks.some((t) => !observed.has(t.id) ? !first || !settled(t) : isActive(t.status) && !observed.get(t.id));
    for (const t of tasks) observed.set(t.id, isActive(t.status));
    if (tab) {
      try { checkTab(tab); }
      catch {
        forgetTab();
        openRequested = false;
      }
    }
    if (wake) openRequested = true;
    if (!tab && openRequested) {
      try {
        ({ tab, pane: rootPane } = openTab(`${mainTabLabel()}-subagents`, `${SELF} ${mode.root} ${enc(cfg)}`));
        openRequested = false;
      } catch (error) { console.error(`tab open failed: ${error.message}`); }
    }
    if (tab && mode.transcripts) {
      peakActive = Math.max(peakActive, active.length);
      for (const t of active) {
        if (slots.some((s) => s.assignment?.task.id === t.id)) continue;
        let slot = slots.find((s) => !s.assignment && s.lastId === t.id) ??
          slots.find((s) => !s.assignment && !active.some((worker) => worker.id === s.lastId));
        try {
          if (!slot && slots.length < peakActive) {
            const from = slots.at(-1)?.paneId ?? rootPane;
            slot = { paneId: openPane(from, slots.length + 1), initialShell: true, assignment: null };
            slots.push(slot);
          }
          if (!slot) continue;
          receiptDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "subagent-streamer-"));
          const token = randomUUID();
          const assignment = { spec: t.spec, token, receiptPath: path.join(receiptDir, token), paneId: slot.paneId, label: t.name, hostPid: cfg.pid, backend: mux };
          slot.assignment = { task: t, token, receiptPath: assignment.receiptPath, launchedAt: Date.now() };
          startPane(slot, assignment);
          allDoneAt = 0;
          console.log(`${streamMode}: added ${t.id}`);
        } catch (error) { console.error(`failed for ${t.id}: ${error.message}`); }
      }
    }
    if (tab && CLOSE_AFTER_MS > 0) {
      if (!tasks.every(settled) || slots.some((s) => s.assignment)) allDoneAt = 0;
      else if (!allDoneAt) allDoneAt = Date.now();
      else if (Date.now() - allDoneAt >= CLOSE_AFTER_MS) {
        try { closeTab(tab); } catch (error) { console.error(`close failed: ${error.message}`); }
        console.log("all subagents done: closed tab");
        forgetTab(); openRequested = false;
      }
    }
    if (hostGone && !tab && tasks.every(settled)) process.exit(0);
    await sleep(AUTO_POLL_MS);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "follow") await follow(dec(arg));
else if (cmd === "board") await board(dec(arg));
else if (cmd === "graph") await graph(dec(arg));
else if (cmd === "auto") await auto(dec(arg));
else { console.error("usage: streamer.mjs auto|board|graph|follow <base64url-json>"); process.exit(2); }
