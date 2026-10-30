import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIN, buildGraph, createActivity, render } from "../src/graph.mjs";
import { loadConfig } from "../src/config.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hss-"));
const line = (o) => JSON.stringify(o) + "\n";
const call = (id, name, args = {}) => line({ type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
const result = (id) => line({ type: "message", message: { role: "toolResult", toolCallId: id, content: [] } });
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("activity: reads only complete lines and tracks the in-flight tool across polls", () => {
  const file = path.join(tmp(), "t.jsonl");
  const half = call("a", "bash");
  fs.writeFileSync(file, line({ type: "session", id: "S1" }) + half.slice(0, 20));
  const a = createActivity(file).poll();
  assert.equal(a.sessionId, "S1");
  assert.equal(a.tools, 0);

  fs.appendFileSync(file, half.slice(20));
  a.poll();
  assert.deepEqual([a.tools, [...a.open.values()]], [1, ["bash"]]);

  fs.appendFileSync(file, result("a") + call("b", "mcp__x__task_send", { to: "fixer" }));
  a.poll();
  assert.deepEqual([a.tools, [...a.open.values()], a.sends.map((s) => s.to)], [2, ["task_send"], ["fixer"]]);
});

test("graph: nests subagents under the session that spawned them and turns task_send into edges", () => {
  const dir = tmp();
  const file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return createActivity(f).poll(); };
  const acts = new Map([
    [MAIN, file("main", call("m1", "task_send", { to: "st_a" }))],
    ["st_a", file("a", line({ type: "session", id: "SA" }) + call("a1", "task_send", { to: "fixer" }) + call("a2", "task_send", { to: "nobody" }))],
    ["st_b", file("b", line({ type: "session", id: "SB" }))],
    ["st_c", file("c", line({ type: "session", id: "SC" }))],
  ]);
  const tasks = [
    { id: "st_a", name: "st_a", description: "scout", status: "running", parent: "S0" },
    { id: "st_b", name: "fixer", status: "completed", parent: "S0" },
    { id: "st_c", name: "deep", status: "running", parent: "SA" },
  ];
  const g = buildGraph({ session: "S0", tasks, acts });

  assert.deepEqual([...g.nodes.values()].map((n) => [n.id, n.name, n.parent]), [[MAIN, "main", null], ["st_a", "scout", MAIN], ["st_b", "fixer", MAIN], ["st_c", "deep", "st_a"]]);
  assert.deepEqual(g.edges.map((e) => [e.kind, e.from, e.to, e.count]), [
    ["spawn", MAIN, "st_a", 1], ["spawn", MAIN, "st_b", 1], ["spawn", "st_a", "st_c", 1], ["message", "st_a", "st_b", 1],
  ]);
  assert.equal(g.nodes.get("st_a").msgIn, 1); // main's follow-up to its own child rides the spawn edge

  const frame = render(g, { cols: 90, rows: 24, now: Date.parse("2026-01-01T00:00:05Z") });
  assert.equal(frame.length, 24);
  const text = frame.map(plain).join("\n");
  for (const label of ["main", "scout", "fixer", "deep", "▶"]) assert.ok(text.includes(label), `frame shows ${label}`);
});

test("graph: an unknown parent session or a parent loop hangs the subagent off main", () => {
  const tasks = [
    { id: "st_x", name: "x", status: "running", parent: "elsewhere" },
    { id: "st_y", name: "y", status: "running", parent: "SZ" },
    { id: "st_z", name: "z", status: "running", parent: "SY" },
  ];
  const acts = new Map([["st_y", { sessionId: "SY", tools: 0, open: new Map(), sends: [] }], ["st_z", { sessionId: "SZ", tools: 0, open: new Map(), sends: [] }]]);
  const g = buildGraph({ session: "S0", tasks, acts });
  assert.equal(g.nodes.get("st_x").parent, MAIN);
  assert.ok([g.nodes.get("st_y").parent, g.nodes.get("st_z").parent].includes(MAIN), "loop broken at main");
  assert.equal(render(g, { cols: 80, rows: 20 }).length, 20);
});

test("config: streamMode defaults to tail, reads the file, env wins, unknown values fall back", () => {
  const file = path.join(tmp(), "config.json");
  assert.deepEqual(loadConfig(file, {}), { streamMode: "tail" });
  fs.writeFileSync(file, JSON.stringify({ streamMode: "graph" }));
  assert.deepEqual(loadConfig(file, {}), { streamMode: "graph" });
  assert.deepEqual(loadConfig(file, { HERDR_SUBAGENT_STREAMER_STREAM_MODE: "tail" }), { streamMode: "tail" });
  fs.writeFileSync(file, JSON.stringify({ streamMode: "grid" }));
  assert.deepEqual(loadConfig(file, {}), { streamMode: "tail" });
});
