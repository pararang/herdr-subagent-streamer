#!/usr/bin/env node
// herdr-subagent-streamer: one multiplexer tab per session's subagents, in one of two stream modes:
//   tail  (default) one live split per subagent;  graph  one pane drawing the agent flow graph
//   streamer.mjs auto  <cfg>    watch this session's subagents; open the tab (and splits in tail mode)
//   streamer.mjs board <cfg>    status list (root pane of the tab in tail mode)
//   streamer.mjs graph <cfg>    flow graph (the only pane of the tab in graph mode)
//   streamer.mjs follow <spec>  pretty-tail one subagent until it settles
// <cfg>/<spec> are base64url JSON; the extension builds them, nobody types them.
// Mux: herdr when HERDR_ENV=1, else tmux when $TMUX is set (override: HERDR_SUBAGENT_STREAMER_MUX).
// Node >= 18 or bun; no dependencies.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TERMINAL, foldFeed, hostFor, resolve } from "./hosts.mjs";
import { loadConfig } from "./config.mjs";
import { MAIN, buildGraph, createActivity, render } from "./graph.mjs";

const SELF = `${q(process.execPath)} ${q(fileURLToPath(import.meta.url))}`;
const CLOSE_AFTER_MS = Number(process.env.HERDR_SUBAGENT_STREAMER_CLOSE_MS ?? 5000); // 0 keeps the tab open
const mux = process.env.HERDR_SUBAGENT_STREAMER_MUX ?? (process.env.HERDR_ENV === "1" ? "herdr" : process.env.TMUX ? "tmux" : "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s).replace(/\s+/g, " ");
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const dec = (s) => JSON.parse(Buffer.from(s, "base64url").toString());
function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ---------- follow: pretty-tail one transcript ----------
async function follow(spec) {
  let done = 0, settled = false, label = spec.id ?? spec.taskFile;
  console.log(C(1, `== ${label} ==`));
  while (true) {
    const { status, transcript } = resolve(spec);
    if (transcript && fs.existsSync(transcript)) {
      const lines = fs.readFileSync(transcript, "utf8").split("\n");
      lines.pop(); // last element is empty or a partial line: wait for its newline
      for (const line of lines.slice(done)) print(line);
      done = lines.length;
    }
    if (settled) break;
    if (TERMINAL.includes(status)) { console.log(C(1, `== ${status} ==`)); settled = true; continue; } // one more drain pass
    await sleep(400);
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
      g = buildGraph({ session: cfg.session, tasks, acts, mainAlive: !cfg.pid || alive(cfg.pid) });
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
    run("herdr", ["pane", "run", r.root_pane.pane_id, cmd]);
    return { pane: r.root_pane.pane_id, tab: r.tab.tab_id };
  }
  const pane = run("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", label, cmd]);
  return { pane, tab: pane };
}

// Split off `from`; alternate right/down so a fan-out stays a grid. Returns the new pane id.
function openPane(from, i, label, cmd) {
  if (mux === "herdr") {
    const id = hj("pane", "split", from, "--direction", i % 2 ? "right" : "down", "--no-focus", "--cwd", process.cwd()).pane.pane_id;
    run("herdr", ["pane", "rename", id, label]);
    run("herdr", ["pane", "run", id, cmd]);
    return id;
  }
  const id = run("tmux", ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", from, cmd]);
  run("tmux", ["select-pane", "-t", id, "-T", label]);
  run("tmux", ["select-layout", "-t", id, "tiled"]);
  return id;
}

const closeTab = (tab) => (mux === "herdr" ? run("herdr", ["tab", "close", tab]) : run("tmux", ["kill-window", "-t", tab]));
// Throws when the user closed the tab, like openPane does in tail mode.
const checkTab = (tab) => (mux === "herdr" ? hj("tab", "get", tab) : run("tmux", ["display", "-p", "-t", tab, "#{pane_id}"]));

// Per stream mode: what the tab's root pane runs, and what a new subagent adds to the tab.
const MODES = {
  tail: { root: "board", attach: (last, n, t) => openPane(last, n, t.name, `${SELF} follow ${enc(t.spec)}`) },
  graph: { root: "graph", attach: (last, _n, _t, tab) => (checkTab(tab), last) },
};

// ---------- auto ----------
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function auto(cfg) {
  if (!mux) throw new Error("needs herdr (HERDR_ENV=1) or tmux ($TMUX)");
  const host = hostFor(cfg);
  const { streamMode } = loadConfig();
  const mode = MODES[streamMode];
  const seen = new Set(), inTab = new Set();
  let tab = "", last = "", n = 0, allDoneAt = 0;
  process.on("SIGTERM", () => { try { if (tab) closeTab(tab); } finally { process.exit(0); } });
  console.log(`streamer (${mux}, ${cfg.host}, ${streamMode}, session ${String(cfg.session).slice(0, 8)}): waiting for subagents`);
  for (let first = true; ; first = false) {
    const tasks = host.list();
    const hostGone = cfg.pid && !alive(cfg.pid);
    // omp subagents live inside the agent process and die with it, so they never report a final status
    const settled = (t) => TERMINAL.includes(t.status) || (hostGone && cfg.host === "omp");
    for (const t of tasks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (first && TERMINAL.includes(t.status)) continue; // finished before we started
      try {
        if (!tab) ({ tab, pane: last } = openTab(`${mainTabLabel()}-subagents`, `${SELF} ${mode.root} ${enc(cfg)}`));
        last = mode.attach(last, ++n, t, tab);
        inTab.add(t.id); allDoneAt = 0;
        console.log(`${streamMode}: added ${t.id}`);
      } catch (e) { // tab was closed by the user: recreate on the next subagent
        console.error(`failed for ${t.id}: ${e.message}`);
        tab = last = ""; n = 0; inTab.clear(); seen.delete(t.id);
      }
    }
    // every subagent in the tab settled: close the tab after CLOSE_AFTER_MS
    if (tab && CLOSE_AFTER_MS > 0) {
      if (!tasks.filter((t) => inTab.has(t.id)).every(settled)) allDoneAt = 0;
      else if (!allDoneAt) allDoneAt = Date.now();
      else if (Date.now() - allDoneAt >= CLOSE_AFTER_MS) {
        try { closeTab(tab); } catch (e) { console.error(`close failed: ${e.message}`); } // already gone is fine
        console.log("all subagents done: closed tab");
        tab = last = ""; n = 0; inTab.clear(); allDoneAt = 0;
      }
    }
    if (hostGone && !tab && tasks.every(settled)) process.exit(0); // agent exited and nothing is left to show
    await sleep(1000);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "follow") await follow(dec(arg));
else if (cmd === "board") await board(dec(arg));
else if (cmd === "graph") await graph(dec(arg));
else if (cmd === "auto") await auto(dec(arg));
else { console.error("usage: streamer.mjs auto|board|graph|follow <base64url-json>"); process.exit(2); }
