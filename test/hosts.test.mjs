import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { omoHost, ompHost, resolve } from "../src/hosts.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hss-"));

test("omo: lists only this session's subagents and resolves the live transcript", () => {
  const home = tmp();
  process.env.OMO_CODING_AGENT_DIR = home;
  const base = path.join(home, "projects", "p1", "senpi-task");
  fs.mkdirSync(path.join(base, "tasks"), { recursive: true });
  const rec = (id, root, status) => fs.writeFileSync(path.join(base, "tasks", `${id}.json`), JSON.stringify({ task_id: id, name: id, root_session_id: root, status, created_at: "2026-01-01T00:00:00Z" }));
  rec("st_a", "S1", "running");
  rec("st_b", "S2", "running");
  const chat = path.join(base, "children", "st_a", "sessions", "st_a");
  fs.mkdirSync(chat, { recursive: true });
  fs.writeFileSync(path.join(chat, "x.jsonl"), "{}\n");

  const list = omoHost("S1").list();
  assert.deepEqual(list.map((t) => t.id), ["st_a"]);
  assert.deepEqual(resolve(list[0].spec), { status: "running", transcript: path.join(chat, "x.jsonl") });
});

test("omo: a stale running record settles once the transcript ends in a quiet plain reply", () => {
  const home = tmp();
  process.env.OMO_CODING_AGENT_DIR = home;
  const base = path.join(home, "projects", "p1", "senpi-task");
  fs.mkdirSync(path.join(base, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(base, "tasks", "st_c.json"), JSON.stringify({ task_id: "st_c", name: "c", root_session_id: "S1", status: "running", created_at: "2026-01-01T00:00:00Z" }));
  const dir = path.join(base, "children", "st_c", "sessions", "st_c");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "x.jsonl");
  const msg = (role, content) => JSON.stringify({ type: "message", message: { role, content } }) + "\n";
  const age = () => { const old = new Date(Date.now() - 60000); fs.utimesSync(file, old, old); };

  fs.writeFileSync(file, msg("assistant", [{ type: "toolCall", name: "bash" }]));
  age();
  assert.equal(omoHost("S1").list()[0].status, "running"); // mid tool call: still working

  fs.writeFileSync(file, msg("assistant", [{ type: "text", text: "done" }]));
  assert.equal(omoHost("S1").list()[0].status, "running"); // reply just written: not quiet yet
  age();
  assert.equal(omoHost("S1").list()[0].status, "completed");
});

test("omp: folds lifecycle feed into status and falls back to the artifacts dir", () => {
  const feed = path.join(tmp(), "feed.jsonl");
  fs.writeFileSync(feed, [
    { type: "session", sessionFile: "/s/2026.jsonl" },
    { ts: 1000, id: "Scout", agent: "scout", status: "started" },
    { ts: 2000, id: "Scout", agent: "scout", status: "completed" },
    { ts: 1500, id: "Fixer", agent: "task", status: "started", sessionFile: "/s/2026/Fixer.jsonl" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");

  const list = ompHost(feed).list();
  assert.deepEqual(list.map((t) => [t.id, t.status]), [["Scout", "completed"], ["Fixer", "running"]]);
  assert.equal(resolve(list[0].spec).transcript, "/s/2026/Scout.jsonl");
  assert.equal(resolve(list[1].spec).transcript, "/s/2026/Fixer.jsonl");
});
