// OMP plugin extension (`omp.extensions`); omo native loads the same entry via `pi.extensions`.
// On session start it launches the streamer for this session. The streamer ends itself once the agent has
// exited and its subagents have settled, because omo subagents can outlive their parent process.
// Inert outside herdr/tmux, so installing it everywhere is safe.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { existingStreamer, launch, paneFiles } from "../src/launch.mjs";

const inMux = process.env.HERDR_ENV === "1" || !!process.env.TMUX;
const pane = process.env.HERDR_PANE_ID ?? process.env.TMUX_PANE ?? "";
const host = process.env.HERDR_SUBAGENT_STREAMER_HOST ?? (process.env.OMO_NATIVE === "1" ? "omo" : "omp");
let subscribed = false; // module state is shared by child sessions, so subscribe once

const runtime = () => [process.execPath, "bun", "node"].find((r) => /(^|[\\/])(bun|node)(\.exe)?$/.test(r) && spawnSync(r, ["--version"], { windowsHide: true }).status === 0);

function start(ctx) {
  const session = process.env.PI_SESSION_ID || ctx.sessionManager?.getSessionId?.();
  const rt = runtime();
  if (!session || !rt) return;
  if (existingStreamer({ pane, owner: process.pid, session })) return;
  launch({
    pane, owner: process.pid, runtime: rt,
    cfg: { host, session, pid: process.pid },
    header: { type: "session", sessionFile: ctx.sessionManager?.getSessionFile?.() },
  });
}

export default function herdrSubagentStreamer(pi) {
  if (!inMux) return;
  // omp pushes subagent state on its event bus; the streamer reads it back from the feed file.
  // omo never emits this channel (the streamer polls its task records instead), so this is a no-op there.
  if (!subscribed && pi.events?.on) {
    subscribed = true;
    const feed = paneFiles(pane).feed;
    pi.events.on("task:subagent:lifecycle", (p) => {
      try { fs.appendFileSync(feed, JSON.stringify({ ts: Date.now(), id: p.id, agent: p.agent, status: p.status, sessionFile: p.sessionFile }) + "\n"); } catch {}
    });
  }
  pi.on("session_start", (_e, ctx) => { if (ctx.agent?.kind !== "sub") start(ctx); });
}
