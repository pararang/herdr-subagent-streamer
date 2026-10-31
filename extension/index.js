// OMP plugin extension (`omp.extensions`); omo native loads the same entry via `pi.extensions`.
// On session start it launches the streamer for this session. The streamer ends itself once the agent has
// exited and its subagents have settled, because omo subagents can outlive their parent process.
// Inert outside herdr/tmux, so installing it everywhere is safe.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STREAMER = fileURLToPath(new URL("../src/streamer.mjs", import.meta.url));
const inMux = process.env.HERDR_ENV === "1" || !!process.env.TMUX;
const pane = process.env.HERDR_PANE_ID ?? process.env.TMUX_PANE ?? "";
const dir = path.join(os.tmpdir(), "herdr-subagent-streamer");
const key = pane.replace(/\W/g, "_");
const pidFile = path.join(dir, `${key}.pid`);
const feedFile = path.join(dir, `${key}.feed.jsonl`);
const logFile = path.join(dir, `${key}.log`);
const host = process.env.HERDR_SUBAGENT_STREAMER_HOST ?? (process.env.OMO_NATIVE === "1" ? "omo" : "omp");
let subscribed = false; // module state is shared by child sessions, so subscribe once

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = () => { try { return JSON.parse(fs.readFileSync(pidFile, "utf8")); } catch { return null; } };
const runtime = () => [process.execPath, "bun", "node"].find((r) => /(^|[\\/])(bun|node)(\.exe)?$/.test(r) && spawnSync(r, ["--version"]).status === 0);

function start(ctx) {
  const session = process.env.PI_SESSION_ID || ctx.sessionManager?.getSessionId?.();
  const rt = runtime();
  if (!session || !rt) return;
  const cur = readPid();
  if (cur && alive(cur.pid)) {
    // A live owner other than us is the main agent (omo subagents are separate processes that load this
    // extension too) and must keep its streamer; a dead owner's streamer is stale and gets replaced.
    if (alive(cur.owner) && (cur.owner !== process.pid || cur.session === session)) return;
    process.kill(cur.pid);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(feedFile, JSON.stringify({ type: "session", sessionFile: ctx.sessionManager?.getSessionFile?.() }) + "\n");
  const cfg = Buffer.from(JSON.stringify({ host, session, feed: feedFile, pid: process.pid })).toString("base64url");
  const log = fs.openSync(logFile, "a");
  const child = spawn(rt, [STREAMER, "auto", cfg], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, owner: process.pid, session }));
}

export default function herdrSubagentStreamer(pi) {
  if (!inMux) return;
  // omp pushes subagent state on its event bus; the streamer reads it back from the feed file.
  // omo never emits this channel (the streamer polls its task records instead), so this is a no-op there.
  if (!subscribed && pi.events?.on) {
    subscribed = true;
    pi.events.on("task:subagent:lifecycle", (p) => {
      try { fs.appendFileSync(feedFile, JSON.stringify({ ts: Date.now(), id: p.id, agent: p.agent, status: p.status, sessionFile: p.sessionFile }) + "\n"); } catch {}
    });
  }
  pi.on("session_start", (_e, ctx) => { if (ctx.agent?.kind !== "sub") start(ctx); });
}
