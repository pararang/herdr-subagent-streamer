#!/usr/bin/env node
// herdr-subagent-streamer: one multiplexer tab per session's subagents, in one of three stream modes:
//   hybrid (default)  graph plus reusable active-worker splits
//   tail              board plus active-worker splits
//   graph             one pane drawing the agent flow graph
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
import { fileURLToPath } from "node:url";
import { TERMINAL, hostFor, resolve } from "./hosts.mjs";
import { loadConfig } from "./config.mjs";
import { MAIN, buildGraph, createActivity, render } from "./graph.mjs";
import { selfCommand } from "./command.mjs";
import { detectMux, muxFor } from "./mux.mjs";
import { createTail } from "./transcript.mjs";

const SELF = selfCommand(process.execPath, fileURLToPath(import.meta.url), process.platform);
const CLOSE_AFTER_MS = Number(process.env.HERDR_SUBAGENT_STREAMER_CLOSE_MS ?? 5000); // 0 keeps the tab open
const ACTIVE_STATUSES = ["started", "running"];
const FOLLOW_POLL_MS = 400;
const AUTO_POLL_MS = 1000;
const FOLLOW_START_TIMEOUT_MS = 10000;
const RESET_TRANSCRIPT = "\x1b[3J\x1b[H\x1b[2J";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s).replace(/\s+/g, " ");
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const dec = (s) => JSON.parse(Buffer.from(s, "base64url").toString());
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
  let tail;
  const drain = (transcript) => {
    if (!transcript) return;
    if (tail?.file !== transcript) tail = createTail(transcript);
    for (const e of tail.poll()) print(e);
  };
  receipt(assignment, "started");
  try {
    await flush(RESET_TRANSCRIPT);
    muxFor(backend).retitle(paneId, label);
    console.log(C(1, `== ${label} ==`));
    while (true) {
      const { status, transcript } = resolve(spec);
      drain(transcript);
      const hostGone = hostPid && !alive(hostPid);
      if (!isActive(status) || hostGone) {
        // Preserve the existing final complete-record pass, not an unbounded late-write promise.
        drain(resolve(spec).transcript);
        console.log(C(1, `== ${hostGone ? "host exited" : status ?? "inactive"} ==`));
        await flush();
        receipt(assignment, "drained");
        return;
      }
      await sleep(FOLLOW_POLL_MS);
    }
  } catch (error) {
    receipt(assignment, "failed", { error: error.message });
    throw error;
  }
}

function print(e) {
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
      track(MAIN, host.mainTranscript());
      for (const t of tasks) track(t.id, resolve(t.spec).transcript);
      g = buildGraph({ session: cfg.session, tasks, acts });
    }
    const lines = render(g, { cols: process.stdout.columns || 100, rows: process.stdout.rows || 30, frame, title });
    process.stdout.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
    await sleep(250);
  }
}

const MODES = {
  hybrid: { root: "graph", transcripts: true },
  tail: { root: "board", transcripts: true },
  graph: { root: "graph", transcripts: false },
};

// ---------- auto ----------
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function auto(cfg) {
  const muxName = detectMux();
  const mux = muxFor(muxName);
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
  process.on("SIGTERM", () => { try { if (tab) mux.closeTab(tab); } finally { process.exit(0); } });
  console.log(`streamer (${muxName}, ${cfg.host}, ${streamMode}, session ${String(cfg.session).slice(0, 8)}): waiting for subagents`);
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
      try { mux.closePane(slot.paneId); }
      catch (error) {
        if (mux.hasPane(slot.paneId)) { console.error(`pane cleanup failed: ${error.message}`); continue; }
      }
      fs.rmSync(a.receiptPath, { force: true });
      slots.splice(slots.indexOf(slot), 1);
    }
    const tasks = host.list();
    const hostGone = cfg.pid && !alive(cfg.pid);
    const settled = (t) => TERMINAL.includes(t.status) || (hostGone && host.diesWithAgent);
    const active = tasks.filter((t) => isActive(t.status) && !settled(t));
    const wake = tasks.some((t) => !observed.has(t.id) ? !first || !settled(t) : isActive(t.status) && !observed.get(t.id));
    for (const t of tasks) observed.set(t.id, isActive(t.status));
    if (tab && !mux.hasTab(tab)) {
      forgetTab();
      openRequested = false;
    }
    if (wake) openRequested = true;
    if (!tab && openRequested) {
      try {
        ({ tab, pane: rootPane } = mux.openTab(`${mux.mainTabLabel()}-subagents`, `${SELF} ${mode.root} ${enc(cfg)}`));
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
            slot = { paneId: mux.openPane(from, slots.length + 1), assignment: null };
            slots.push(slot);
          }
          if (!slot) continue;
          receiptDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "subagent-streamer-"));
          const token = randomUUID();
          const assignment = { spec: t.spec, token, receiptPath: path.join(receiptDir, token), paneId: slot.paneId, label: t.name, hostPid: host.diesWithAgent ? cfg.pid : undefined, backend: muxName };
          slot.assignment = { task: t, token, receiptPath: assignment.receiptPath, launchedAt: Date.now() };
          mux.run(slot.paneId, `${SELF} follow ${enc(assignment)}`);
          allDoneAt = 0;
          console.log(`${streamMode}: added ${t.id}`);
        } catch (error) { console.error(`failed for ${t.id}: ${error.message}`); }
      }
    }
    if (tab && CLOSE_AFTER_MS > 0) {
      if (!tasks.every(settled) || slots.some((s) => s.assignment)) allDoneAt = 0;
      else if (!allDoneAt) allDoneAt = Date.now();
      else if (Date.now() - allDoneAt >= CLOSE_AFTER_MS) {
        try { mux.closeTab(tab); } catch (error) { console.error(`close failed: ${error.message}`); }
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
