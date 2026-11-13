#!/usr/bin/env node
// herdr-subagent-streamer: one multiplexer tab per session's subagents, in one of three stream modes:
//   hybrid (default)  graph plus reusable active-worker splits
//   tail              board plus active-worker splits
//   graph             one pane drawing the agent flow graph
//   streamer.mjs auto  <cfg>    watch this session's subagents; open the tab (and splits in hybrid/tail mode)
//   streamer.mjs board <cfg>    status list (root pane of the tab in tail mode)
//   streamer.mjs graph <cfg>    flow graph (root pane of the tab in hybrid/graph mode)
//   streamer.mjs follow <assignment>  pretty-tail one assigned subagent until it becomes inactive
// Arguments are base64url JSON; the launcher builds cfg, auto builds follower assignments.
// Node >= 18 or bun; no dependencies.
import { fileURLToPath } from "node:url";
import { hostFor, resolve } from "./hosts.mjs";
import { loadConfig } from "./config.mjs";
import { MAIN, buildGraph, createActivity, render } from "./graph.mjs";
import { decodeArg, encodeArg, selfCommand } from "./command.mjs";
import { detectMux, muxFor } from "./mux.mjs";
import { createFollowers, follow } from "./follower.mjs";
import { createSession } from "./session.mjs";
import { alive } from "./launch.mjs";

const SELF = selfCommand(process.execPath, fileURLToPath(import.meta.url), process.platform);
const CLOSE_AFTER_MS = Number(process.env.HERDR_SUBAGENT_STREAMER_CLOSE_MS ?? 5000); // 0 keeps the tab open
const AUTO_POLL_MS = 1000;
const MODES = {
  hybrid: { root: "graph", transcripts: true },
  tail: { root: "board", transcripts: true },
  graph: { root: "graph", transcripts: false },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = (n, s) => `\x1b[${n}m${s}\x1b[0m`;

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

// ---------- auto ----------
async function auto(cfg) {
  const muxName = detectMux();
  const mux = muxFor(muxName);
  if (!mux) throw new Error("needs herdr (HERDR_ENV=1) or tmux ($TMUX)");
  const host = hostFor(cfg);
  const { streamMode } = loadConfig();
  const mode = MODES[streamMode];
  const followers = createFollowers({
    mux, backend: muxName, command: (assignment) => `${SELF} follow ${encodeArg(assignment)}`,
    hostPid: host.diesWithAgent ? cfg.pid : undefined,
  });
  const session = createSession({
    host, mux, followers, rootCommand: `${SELF} ${mode.root} ${encodeArg(cfg)}`, transcripts: mode.transcripts,
    modeName: streamMode, hostPid: cfg.pid, closeAfterMs: CLOSE_AFTER_MS, alive,
  });
  process.on("exit", () => followers.dispose());
  process.on("SIGTERM", () => { try { session.close(); } finally { process.exit(0); } });
  console.log(`streamer (${muxName}, ${cfg.host}, ${streamMode}, session ${String(cfg.session).slice(0, 8)}): waiting for subagents`);
  while (!session.tick()) await sleep(AUTO_POLL_MS);
  process.exit(0);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "follow") await follow(decodeArg(arg));
else if (cmd === "board") await board(decodeArg(arg));
else if (cmd === "graph") await graph(decodeArg(arg));
else if (cmd === "auto") await auto(decodeArg(arg));
else { console.error("usage: streamer.mjs auto|board|graph|follow <base64url-json>"); process.exit(2); }
