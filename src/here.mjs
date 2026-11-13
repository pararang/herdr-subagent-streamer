// Start the subagent streamer for an opencode pane in herdr (run through bin/streamer-here.sh).
//   here.mjs [PANE_ID]           start now
//   here.mjs --watch [PANE_ID]   wait for this pane's session to spawn a subagent, then start
// --watch is what the opencode plugin uses: most sessions never spawn a subagent, so idle panes get
// no streamer process.
// STREAMER_SESSION pins the session, for a run herdr does not register (`opencode run`) or a session
// watched from another pane. STREAMER_HOST_PID is the opencode process, so the streamer can tell
// when it has exited.
import { run } from "./mux.mjs";
import { query } from "./opencode.mjs";
import { existingStreamer, launch } from "./launch.mjs";

const WATCH_MS = 5000;
const herdrBin = process.env.HERDR ?? "herdr";
const die = (message) => { console.error(`streamer-here: ${message}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const paneGet = (pane) => { try { return JSON.parse(run(herdrBin, ["pane", "get", pane])).result.pane; } catch { return null; } };

const args = process.argv.slice(2);
const watch = args[0] === "--watch";
if (watch) args.shift();
const pane = args[0] || process.env.HERDR_PANE_ID || paneGet("--current")?.pane_id;
if (!pane) die("no pane: pass one, or run inside herdr");

const info = paneGet(pane);
const pinned = process.env.STREAMER_SESSION;
const agent = pinned ? "opencode" : info?.agent || "none";
let session = pinned || info?.agent_session?.value || "none";
if (agent !== "opencode" && !watch) die(`pane ${pane} runs '${agent}', not opencode`);
// A pane only gains a session once it is prompted, so watch mode waits rather than giving up.
if (session === "none" && !watch) die(`pane ${pane} has no opencode session yet; send it a prompt first`);

const running = existingStreamer({ pane, session });
if (running) {
  console.log(`already streaming ${session} (pid ${running})`);
  process.exit(0);
}

// `since` scopes the view to subagents spawned from now on, not the session's whole history.
let since = Date.now();
while (watch) {
  await sleep(WATCH_MS);
  const live = paneGet(pane);
  if (!live) process.exit(0);
  // Herdr reports no session before the first prompt, and again whenever a run does not register
  // one, so only a different non-empty session replaces the one being watched.
  const current = pinned || live.agent_session?.value;
  if (current && current !== session) {
    session = current;
    since = Date.now();
  }
  if (session === "none") continue;
  const [row] = query("SELECT COUNT(*) AS n FROM session_v2 WHERE parent_id = ? AND time_created >= ?", [session, since]);
  if (row?.n > 0) break;
}

const hostPid = Number(process.env.STREAMER_HOST_PID) || undefined;
const { pid, log } = launch({
  pane,
  cfg: { host: "opencode", session, since, pid: hostPid },
  header: { type: "session", id: session },
  env: { ...process.env, HERDR_SUBAGENT_STREAMER_HOST: "opencode", HERDR_ENV: "1", HERDR_PANE_ID: pane },
});
console.log(`streaming subagents of ${session} for pane ${pane} (pid ${pid}, log ${log})`);
