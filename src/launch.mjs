// Launcher: one detached streamer per multiplexer pane, shared by the OMP/omo extension and here.mjs.
// Per pane, under <tmpdir>/herdr-subagent-streamer/<pane>:
//   .pid         {pid, owner?, session}   the running streamer; owner is the agent process that started it
//   .feed.jsonl  a session header line, then (omp) lifecycle events appended by the extension
//   .log         the streamer's stdout and stderr
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeArg } from "./command.mjs";

const STREAMER = fileURLToPath(new URL("./streamer.mjs", import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function paneFiles(pane) {
  const dir = path.join(os.tmpdir(), "herdr-subagent-streamer");
  const key = pane.replace(/\W/g, "_");
  return { dir, pid: path.join(dir, `${key}.pid`), feed: path.join(dir, `${key}.feed.jsonl`), log: path.join(dir, `${key}.log`) };
}

// Returns the pid of a live streamer to keep, after killing a stale one. A streamer started by another
// live owner keeps running, because omo subagents are separate processes that load the extension too;
// so does one already streaming this session. A streamer without an owner was started by hand.
export function existingStreamer({ pane, owner, session }) {
  let cur; try { cur = JSON.parse(fs.readFileSync(paneFiles(pane).pid, "utf8")); } catch { return null; }
  if (!cur || !alive(cur.pid)) return null;
  const curOwner = cur.owner || undefined; // the bash launcher wrote owner 0 for a hand-started streamer
  if ((!curOwner || alive(curOwner)) && (curOwner !== owner || cur.session === session)) return cur.pid;
  process.kill(cur.pid);
  return null;
}

// cfg is the streamer's config without its feed path; header is the feed's first line.
export function launch({ pane, owner, cfg, header, runtime = process.execPath, env = process.env }) {
  const files = paneFiles(pane);
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.feed, JSON.stringify(header) + "\n");
  const log = fs.openSync(files.log, "a");
  const child = spawn(runtime, [STREAMER, "auto", encodeArg({ ...cfg, feed: files.feed })], { detached: true, stdio: ["ignore", log, log], env, windowsHide: true });
  child.unref();
  fs.writeFileSync(files.pid, JSON.stringify({ pid: child.pid, owner, session: cfg.session }));
  return { pid: child.pid, log: files.log };
}
