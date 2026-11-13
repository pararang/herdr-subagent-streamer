// Followers: a process in a transcript pane that prints one subagent's transcript until it goes inactive.
//   follow(assignment)                          the pane side: `streamer.mjs follow <assignment>`
//   createFollowers(...).create(task)           the streamer side: start it in a pane, poll its state, release it
// The two sides share only a receipt file, rewritten atomically: started, then drained or failed.
// A pane is reusable only after its follower wrote "drained" and exited, so the next follower never
// inherits a half-printed transcript.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isActive, resolve } from "./hosts.mjs";
import { muxFor } from "./mux.mjs";
import { createTail } from "./transcript.mjs";

const POLL_MS = 400;
const START_TIMEOUT_MS = 10000;
const RESET_TRANSCRIPT = "\x1b[3J\x1b[H\x1b[2J";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s).replace(/\s+/g, " ");
const flush = (text = "") => new Promise((ok, fail) => process.stdout.write(text, (err) => err ? fail(err) : ok()));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readReceipt = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// ---------- pane side ----------
// hostPid is set only for hosts whose subagents die with the agent: its exit ends the transcript.
export async function follow({ spec, token, receiptPath, paneId, label, hostPid, backend }) {
  const receipt = (phase, details = {}) => {
    fs.writeFileSync(`${receiptPath}.tmp`, JSON.stringify({ token, pid: process.pid, phase, ...details }));
    fs.renameSync(`${receiptPath}.tmp`, receiptPath);
  };
  let tail;
  const drain = (transcript) => {
    if (!transcript) return;
    if (tail?.file !== transcript) tail = createTail(transcript);
    for (const e of tail.poll()) print(e);
  };
  receipt("started");
  try {
    await flush(RESET_TRANSCRIPT);
    muxFor(backend).retitle(paneId, label);
    console.log(C(1, `== ${label} ==`));
    while (true) {
      const { status, transcript } = resolve(spec);
      drain(transcript);
      const hostGone = hostPid && !pidAlive(hostPid);
      if (!isActive(status) || hostGone) {
        // Preserve the existing final complete-record pass, not an unbounded late-write promise.
        drain(resolve(spec).transcript);
        console.log(C(1, `== ${hostGone ? "host exited" : status ?? "inactive"} ==`));
        await flush();
        receipt("drained");
        return;
      }
      await sleep(POLL_MS);
    }
  } catch (error) {
    receipt("failed", { error: error.message });
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

// ---------- streamer side ----------
// command(assignment) is the shell command that runs follow(assignment) in a pane.
export function createFollowers({ mux, backend, command, hostPid, now = Date.now, alive = pidAlive }) {
  let dir;
  return {
    // state(): "running" while starting or printing, "drained" once the pane is reusable, or
    // "failed" with a reason, after which the pane holds output no other task should inherit.
    create(task) {
      dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "subagent-streamer-"));
      const token = randomUUID();
      const receiptPath = path.join(dir, token);
      const launchedAt = now();
      return {
        taskId: task.id,
        start(paneId) {
          mux.run(paneId, command({ spec: task.spec, token, receiptPath, paneId, label: task.name, hostPid, backend }));
        },
        state() {
          const r = readReceipt(receiptPath);
          const matches = r?.token === token;
          if (matches && alive(r.pid)) return { phase: "running" };
          if (matches && r.phase === "drained") return { phase: "drained" };
          if (!matches && now() - launchedAt < START_TIMEOUT_MS) return { phase: "running" };
          return { phase: "failed", reason: matches ? r.error ?? "exited without final drain" : "startup receipt missing" };
        },
        release: () => fs.rmSync(receiptPath, { force: true }),
      };
    },
    dispose() { if (dir) fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
