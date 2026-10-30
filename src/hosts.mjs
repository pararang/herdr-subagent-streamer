// Host adapters: turn "where does this coding agent keep its subagents" into one shape.
//   list()            -> [{ id, name, status, category, created, started, ended, spec, parent?, description? }]
//                        parent: the spawning session's id (omo only; omp subagents all hang off the main agent)
//   resolve(spec)     -> { status, transcript }   (used by the per-split follower)
// Plain node builtins only, so this runs under node >= 18 and bun.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TERMINAL = ["completed", "failed", "cancelled", "aborted", "killed", "lost"];

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const agentDir = () => process.env.OMO_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omo", "agent");

// ---------- omo native: senpi-task keeps a JSON record + live transcript per child ----------
const cache = new Map(); // path -> { mtimeMs, rec }: skip re-parsing unchanged records
function cachedJson(p) {
  const m = fs.statSync(p).mtimeMs, c = cache.get(p);
  if (c?.mtimeMs === m) return c.rec;
  const rec = readJson(p);
  cache.set(p, { mtimeMs: m, rec });
  return rec;
}

const transcriptOf = (taskFile) => {
  const id = path.basename(taskFile, ".json");
  const dir = path.join(path.dirname(taskFile), "..", "children", id, "sessions", id);
  const jsonl = ls(dir).filter((f) => f.endsWith(".jsonl")).sort()[0];
  return jsonl && path.join(dir, jsonl);
};

// A detached omo child whose parent already exited never gets its record updated and stays "running".
// Its transcript still tells the truth: a plain assistant reply (no tool call), quiet for 3s, means it finished.
// Returns the finish time in ms, or null.
const endCache = new Map(); // transcript -> { mtimeMs, done }
function finishedAt(file) {
  let mtimeMs; try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }
  if (Date.now() - mtimeMs < 3000) return null;
  let c = endCache.get(file);
  if (c?.mtimeMs !== mtimeMs) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    let last; for (let i = lines.length - 1; i >= 0 && !last; i--) { try { const e = JSON.parse(lines[i]); if (e.type === "message") last = e.message; } catch {} }
    const plainReply = last?.role === "assistant" && Array.isArray(last.content) && !last.content.some((x) => x.type === "toolCall");
    c = { mtimeMs, done: !!plainReply };
    endCache.set(file, c);
  }
  return c.done ? mtimeMs : null;
}

export function omoHost(sessionId) {
  const root = path.join(agentDir(), "projects");
  return {
    list() {
      const out = [];
      for (const proj of ls(root)) {
        const dir = path.join(root, proj, "senpi-task", "tasks");
        for (const f of ls(dir)) {
          if (!f.endsWith(".json")) continue;
          const file = path.join(dir, f);
          let t; try { t = cachedJson(file); } catch { continue; }
          if (t?.root_session_id !== sessionId) continue; // this session and its descendants only
          let { status, terminal_at: ended } = t;
          if (!TERMINAL.includes(status)) {
            const t0 = finishedAt(transcriptOf(file) ?? "");
            if (t0) { status = "completed"; ended = new Date(t0).toISOString(); }
          }
          out.push({ id: t.task_id, name: String(t.name ?? t.task_id), status, category: t.category ?? "", created: t.created_at, started: t.started_at, ended, parent: t.parent_session_id, description: t.description, spec: { host: "omo", taskFile: file } });
        }
      }
      return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
    },
  };
}

function resolveOmo({ taskFile }) {
  const t = readJson(taskFile);
  const transcript = transcriptOf(taskFile);
  const status = !TERMINAL.includes(t?.status) && transcript && finishedAt(transcript) ? "completed" : t?.status;
  return { status, transcript };
}

// ---------- omp: status lives in memory, so the extension forwards task:subagent:lifecycle to a feed ----------
// Feed lines: {type:"session", sessionFile} once, then {ts, id, agent, status, sessionFile?} per event.
export function foldFeed(feed) {
  let text = ""; try { text = fs.readFileSync(feed, "utf8"); } catch { return { sessionFile: undefined, agents: [] }; }
  let sessionFile; const byId = new Map();
  for (const line of text.split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "session") { sessionFile = e.sessionFile; continue; }
    if (!e.id) continue;
    const prev = byId.get(e.id);
    byId.set(e.id, { id: e.id, agent: e.agent ?? prev?.agent ?? "", status: e.status, sessionFile: e.sessionFile ?? prev?.sessionFile, first: prev?.first ?? e.ts, last: e.ts });
  }
  return { sessionFile, agents: [...byId.values()] };
}

// omp writes each child's history to <session file minus .jsonl>/<id>.jsonl
const ompTranscript = (a, sessionFile) => a.sessionFile ?? (sessionFile?.endsWith(".jsonl") ? path.join(sessionFile.slice(0, -6), `${a.id}.jsonl`) : undefined);

export function ompHost(feed) {
  return {
    list() {
      return foldFeed(feed).agents.map((a) => ({
        id: a.id, name: a.id, category: a.agent,
        status: a.status === "started" ? "running" : a.status,
        created: new Date(a.first).toISOString(), started: new Date(a.first).toISOString(),
        ended: TERMINAL.includes(a.status) ? new Date(a.last).toISOString() : undefined,
        spec: { host: "omp", feed, id: a.id },
      }));
    },
  };
}

function resolveOmp({ feed, id }) {
  const { sessionFile, agents } = foldFeed(feed);
  const a = agents.find((x) => x.id === id);
  return { status: a?.status, transcript: a && ompTranscript(a, sessionFile) };
}

export const resolve = (spec) => (spec.host === "omp" ? resolveOmp(spec) : resolveOmo(spec));
export const hostFor = ({ host, session, feed }) => (host === "omp" ? ompHost(feed) : omoHost(session));
