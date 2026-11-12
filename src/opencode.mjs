// opencode host: subagents are child sessions in opencode's sqlite store, not files on disk.
// Two jobs live here: read the child sessions of one root session, and materialise each child's
// messages as the JSONL transcript the follower already knows how to print.
//
// Tables are opencode's v2 set (session_v2 / session_message); a v2 message carries its content
// inline, and a message of type "idle" is the session saying it finished, with an outcome.
// Plain node builtins only; node:sqlite is unflagged from node 22.13, so the sqlite3 CLI is the fallback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const dbPath = () =>
  process.env.OPENCODE_DB ??
  path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode", "opencode.db");

// Every process rebuilds its transcripts from the start, so a shared file would get one copy per process.
let ownDir;
const workDir = () => {
  if (ownDir) return ownDir;
  ownDir = path.join(os.tmpdir(), "herdr-subagent-streamer", "opencode", String(process.pid));
  fs.rmSync(ownDir, { recursive: true, force: true });
  fs.mkdirSync(ownDir, { recursive: true });
  process.on("exit", () => fs.rmSync(ownDir, { recursive: true, force: true }));
  return ownDir;
};

// ---------- reading: node:sqlite when the runtime has it, else the sqlite3 CLI ----------
let db = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  db = new DatabaseSync(dbPath(), { readOnly: true });
} catch {
  db = null;
}

function cliQuery(sql) {
  const out = spawnSync("sqlite3", ["-readonly", "-json", dbPath(), sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) return [];
  try {
    return JSON.parse(out.stdout || "[]");
  } catch {
    return [];
  }
}

export function query(sql, params = []) {
  if (db) {
    try {
      return db.prepare(sql).all(...params);
    } catch {
      return [];
    }
  }
  // The CLI takes no bound parameters, so inline them as quoted literals.
  let i = 0;
  const inlined = sql.replace(/\?/g, () => {
    const v = params[i++];
    return typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  });
  return cliQuery(inlined);
}

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// ---------- child sessions ----------
const SESSION_COLUMNS = "id, parent_id, title, agent, time_created, time_updated";

// The newest message tells the state: an "idle" message means the session came to rest, and its
// outcome says whether that was a success. Anything else means it is still mid-turn.
function settle(row) {
  const last = query(
    `SELECT type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
    [row.id],
  )[0];
  if (!last) return { status: "running", endedAt: undefined };
  if (last.type !== "idle") return { status: "running", endedAt: undefined };
  const outcome = parse(last.data)?.outcome;
  return {
    status: outcome && outcome !== "succeeded" ? "failed" : "completed",
    endedAt: Number(last.time_created),
  };
}

const describe = (row) => {
  const { status, endedAt } = settle(row);
  return {
    id: row.id,
    name: String(row.title || row.agent || row.id),
    status,
    category: row.agent ?? "",
    created: new Date(Number(row.time_created)).toISOString(),
    started: new Date(Number(row.time_created)).toISOString(),
    ended: status === "running" ? undefined : new Date(Number(endedAt ?? row.time_updated)).toISOString(),
    parent: row.parent_id,
    description: row.title,
    spec: { host: "opencode", root: row.parent_id, id: row.id },
  };
};

// `since` keeps the view to this run: the store also holds every subagent the root session ever
// spawned, and resurrecting months-old ones would fill the tab with finished work.
export function childSessions(rootId, since = 0) {
  return query(
    `SELECT ${SESSION_COLUMNS} FROM session_v2 WHERE parent_id = ? AND time_created >= ? ORDER BY time_created`,
    [rootId, Number(since) || 0],
  ).map(describe);
}

export function sessionStatus(id) {
  const row = query(`SELECT ${SESSION_COLUMNS} FROM session_v2 WHERE id = ?`, [id])[0];
  return row ? settle(row).status : undefined;
}

// ---------- transcripts ----------
// The follower tails a JSONL file of envelopes, so project each opencode message onto that shape
// and append only what is new since the last pass.
const written = new Map(); // sessionId -> seq already emitted

// Both readers (the follower's print and the graph's activity ingest) take the same envelope:
// {type:"message", timestamp, message:{role, content:[...], toolCallId?, isError?}}.
function recordsFor(row) {
  const data = parse(row.data);
  if (!data) return [];
  const at = new Date(Number(data.time?.created ?? row.time_created ?? Date.now())).toISOString();
  const wrap = (message) => ({ type: "message", timestamp: at, message });

  if (row.type === "user") {
    const text = typeof data.text === "string" ? data.text : "";
    return text ? [wrap({ role: "user", content: [{ type: "text", text }] })] : [];
  }
  if (row.type !== "assistant") return []; // idle, system, compaction and friends are not transcript lines

  const out = [];
  const content = [];
  const results = [];
  for (const c of Array.isArray(data.content) ? data.content : []) {
    if (c.type === "text" && c.text) content.push({ type: "text", text: c.text });
    else if (c.type === "reasoning" && c.text) content.push({ type: "thinking", thinking: c.text });
    else if (c.type === "tool") {
      const id = c.id ?? `${row.id}:${content.length}`;
      content.push({ type: "toolCall", id, name: c.name ?? "tool", arguments: c.state?.input ?? {} });
      const status = c.state?.status;
      if (status === "completed" || status === "error") {
        const error = c.state.error;
        const text =
          status === "error"
            ? String(error?.message ?? error ?? "")
            : (Array.isArray(c.state.content) ? c.state.content : [])
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n");
        // A tool result is its own record: that is how the follower colours it and how the graph
        // closes the open call.
        results.push(
          wrap({ role: "toolResult", toolCallId: id, isError: status === "error", content: [{ type: "text", text }] }),
        );
      }
    }
  }
  if (content.length) out.push(wrap({ role: "assistant", content }));
  return out.concat(results);
}

// An assistant message keeps changing until opencode stamps time.completed, even after newer
// messages exist. One that was abandoned never gets the stamp, but a later idle row ends the turn.
const isFinal = (row, i, lastIdle) =>
  row.type !== "assistant" || i < lastIdle || parse(row.data)?.time?.completed != null;

// Append only: the follower tails by line count and the graph by byte offset.
export function transcriptFor(sessionId, since = 0) {
  const file = path.join(workDir(), `${sessionId}.jsonl`);
  const rows = query(
    `SELECT id, type, data, seq, time_created FROM session_message WHERE session_id = ? AND seq > ? AND time_created >= ? ORDER BY seq`,
    [sessionId, written.get(sessionId) ?? -1, Number(since) || 0],
  );
  const lastIdle = rows.findLastIndex((r) => r.type === "idle");
  const pending = rows.findIndex((r, i) => !isFinal(r, i, lastIdle));
  const ready = pending === -1 ? rows : rows.slice(0, pending);
  let text = "";
  for (const r of ready) for (const rec of recordsFor(r)) text += JSON.stringify(rec) + "\n";
  fs.appendFileSync(file, text);
  if (ready.length) written.set(sessionId, Number(ready[ready.length - 1].seq));
  return file;
}
