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

function graphFrame(graph, cols, rows = 200) {
  const frame = render(graph, { cols, rows, now: 1_000_000 }).map(plain);
  assert.equal(frame.length, rows, `${cols} columns preserves the requested frame height`);
  assert.ok(frame.every((row) => [...row].length <= cols), `${cols} columns stays within the pane`);
  return frame;
}

function visibleCards(frame, expected) {
  const cards = [];
  for (const [top, row] of frame.entries()) {
    for (const match of row.matchAll(/╭[^╭╮]*╮/g)) {
      const left = match.index;
      const right = left + match[0].length - 1;
      const bottom = frame.findIndex((line, y) => y > top && line[left] === "╰" && line[right] === "╯");
      assert.ok(bottom > top, `card at ${left},${top} has both bottom corners`);
      assert.match(frame[bottom].slice(left + 1, right), /^[─┬]*$/, "the bottom border is complete");
      for (let y = top + 1; y < bottom; y++) {
        assert.equal(frame[y][left], "│", "the left border is complete");
        assert.match(frame[y][right] ?? "", /^[│├]$/, "the right border is complete");
        assert.doesNotMatch(frame[y].slice(left + 1, right), /[─│╭╮╰╯┌┐└┘├┤┬┴┼▶◀▲▼●]/, "edges do not overwrite card interiors");
      }
      cards.push({ left, right, top, bottom, name: match[0].slice(1, -1).replace(/─/g, "").trim() });
    }
  }
  assert.equal(cards.length, expected, "every card has a complete top border");
  const text = frame.join("\n");
  for (const corner of ["╭", "╮", "╰", "╯"]) {
    assert.equal([...text].filter((char) => char === corner).length, expected, `every card has its ${corner} corner`);
  }
  for (const [i, card] of cards.entries()) {
    for (const other of cards.slice(i + 1)) {
      assert.ok(card.right < other.left || other.right < card.left || card.bottom < other.top || other.bottom < card.top, "cards never overlap");
    }
  }
  return cards;
}

function namedCard(cards, name) {
  const matches = cards.filter((card) => card.name === name);
  assert.equal(matches.length, 1, `the complete ${name} name appears on exactly one card`);
  return matches[0];
}

function incomingArrows(frame, card) {
  const arrows = [];
  const take = (x, y, glyph) => {
    if (frame[y]?.[x] === glyph) arrows.push([x, y, glyph]);
  };
  for (let x = card.left; x <= card.right; x++) {
    take(x, card.top - 1, "▼");
    take(x, card.bottom + 1, "▲");
  }
  for (let y = card.top; y <= card.bottom; y++) {
    take(card.left - 1, y, "▶");
    take(card.right + 1, y, "◀");
  }
  return arrows;
}

function unevenTree() {
  const family = [
    ["oak", MAIN], ["ash", MAIN], ["elm", MAIN], ["fir", MAIN],
    ["acorn", "oak"], ["bark", "oak"], ["leaf", "oak"], ["twig", "oak"],
    ["bud", "bark"], ["seed", "bark"], ["root", "ash"],
    ["cone", "fir"], ["fern", "fir"], ["moss", "fir"],
  ];
  const tasks = family.map(([id, parent]) => ({
    id, name: id, parent: parent === MAIN ? "S0" : `session-${parent}`, status: "running",
  }));
  const acts = new Map(tasks.map(({ id }) => [id, { sessionId: `session-${id}`, tools: 0, open: new Map(), sends: [] }]));
  return { graph: buildGraph({ session: "S0", tasks, acts }), names: ["main", ...family.map(([name]) => name)] };
}

test("activity: reads only complete lines and tracks the in-flight tool across polls", () => {
  const file = path.join(tmp(), "t.jsonl");
  const half = call("a", "bash");
  fs.writeFileSync(file, line({ type: "session", id: "S1" }) + half.slice(0, 20));
  const a = createActivity(file).poll();
  assert.equal(a.sessionId, "S1");
  assert.deepEqual([a.tools, a.turn], [0, "waiting"]);

  fs.appendFileSync(file, half.slice(20));
  a.poll();
  assert.deepEqual([a.tools, [...a.open.values()], a.turn], [1, ["bash"], "working"]);

  fs.appendFileSync(file, result("a") + call("b", "mcp__x__task_send", { to: "fixer" }));
  a.poll();
  assert.deepEqual([a.tools, [...a.open.values()], a.sends.map((s) => s.to)], [2, ["task_send"], ["fixer"]]);

  fs.appendFileSync(file, result("b"));
  a.poll();
  assert.equal(a.turn, "working", "a tool result hands the turn back to the agent");
  fs.appendFileSync(file, line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));
  a.poll();
  assert.equal(a.turn, "waiting", "a plain reply ends the turn");
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

  assert.equal(g.nodes.get(MAIN).status, "working", "main's last entry is a tool call");
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

test("graph: wraps agents into visible rows when the pane narrows", () => {
  const tasks = Array.from({ length: 6 }, (_, i) => ({
    id: `agent${i + 1}`, name: `agent${i + 1}`, status: "running", parent: "S0",
  }));
  const graph = buildGraph({ session: "S0", tasks, acts: new Map() });
  for (const cols of [70, 46, 120, 70]) {
    const frame = render(graph, { cols, rows: 60, now: 0 }).map(plain);
    const text = frame.join("\n");
    for (const task of tasks) assert.ok(text.includes(task.name), `${cols} columns shows ${task.name}`);
    assert.equal((text.match(/╮/g) ?? []).length, 7, `${cols} columns shows every card's right border`);
    assert.ok(frame.every((row) => [...row].length <= cols), "frame fits the pane width");
  }
});

test("graph: nested uneven subtrees wrap without hiding cards or crossing their interiors", () => {
  const { graph, names } = unevenTree();
  for (const cols of [70, 46]) {
    const frame = graphFrame(graph, cols);
    const cards = visibleCards(frame, names.length);
    for (const name of names) namedCard(cards, name);
    for (const name of names.filter((name) => name !== "main")) {
      assert.ok(incomingArrows(frame, namedCard(cards, name)).length > 0, `${cols} columns points a spawn arrow at ${name}`);
    }
  }
});

test("graph: messages across wrapped rows and back reach their target with a readable count", () => {
  const tasks = ["one", "two", "three", "four", "five", "six"].map((id) => ({
    id, name: id, parent: "S0", status: "running",
  }));
  const graph = buildGraph({ session: "S0", tasks, acts: new Map() });
  for (const cols of [46, 70]) {
    const baseline = graphFrame(graph, cols);
    const baselineCards = visibleCards(baseline, 7);
    assert.notEqual(namedCard(baselineCards, "one").top, namedCard(baselineCards, "six").top, "the message endpoints occupy different wrapped rows");
    for (const [from, to] of [["one", "six"], ["six", "one"]]) {
      const withMessage = {
        ...graph,
        edges: [...graph.edges, { kind: "message", from, to, count: 123456789, lastAt: 0 }],
      };
      const frame = graphFrame(withMessage, cols);
      const cards = visibleCards(frame, 7);
      for (const name of ["main", ...tasks.map((task) => task.name)]) namedCard(cards, name);
      const target = namedCard(cards, to);
      assert.ok(incomingArrows(frame, target).some(([x, y, glyph]) => baseline[y]?.[x] !== glyph), `${from} to ${to} adds an arrow pointing into the target card`);
      const outside = frame.map((row, y) => [...row].map((char, x) => (
        cards.some((card) => x >= card.left && x <= card.right && y >= card.top && y <= card.bottom) ? " " : char
      )).join("")).join("\n");
      assert.match(outside, /(?:123456789(?: msg)?|(?:×)?\d+\+)/, "the count remains readable outside the cards, either complete or explicitly abbreviated");
    }
  }
});

test("graph: resizing wide to narrow and back restores the same complete frame", () => {
  const { graph, names } = unevenTree();
  const firstWide = graphFrame(graph, 160);
  const narrow = graphFrame(graph, 46);
  const secondWide = graphFrame(graph, 160);
  const secondNarrow = graphFrame(graph, 46);
  for (const frame of [firstWide, narrow, secondWide, secondNarrow]) {
    const cards = visibleCards(frame, names.length);
    for (const name of names) namedCard(cards, name);
  }
  assert.deepEqual(secondWide, firstWide, "returning to the wide pane restores its frame");
  assert.deepEqual(secondNarrow, narrow, "returning to the narrow pane restores its frame");
});

test("graph: very narrow panes retain complete cards and names that fit", () => {
  const tasks = ["a", "b"].map((id) => ({ id, name: id, parent: "S0", status: "running" }));
  const graph = buildGraph({ session: "S0", tasks, acts: new Map() });
  for (const cols of [5, 8, 12, 16]) {
    const frame = graphFrame(graph, cols, 80);
    const cards = visibleCards(frame, 3);
    if (cols >= 8) for (const name of ["a", "b"]) namedCard(cards, name);
    if (cols >= 12) namedCard(cards, "main");
    for (const card of cards.filter((card) => card.name !== "main")) {
      if (card.name === "a" || card.name === "b") {
        assert.ok(incomingArrows(frame, card).length > 0, `${cols} columns keeps the spawn arrow at ${card.name}`);
      }
    }
  }
});

test("config: streamMode defaults to hybrid, reads the file, env wins, unknown values fall back to hybrid", () => {
  const file = path.join(tmp(), "config.json");
  assert.deepEqual(loadConfig(file, {}), { streamMode: "hybrid" });
  assert.deepEqual(loadConfig(file, { HERDR_SUBAGENT_STREAMER_STREAM_MODE: "bogus" }), { streamMode: "hybrid" });
  fs.writeFileSync(file, JSON.stringify({ streamMode: "graph" }));
  assert.deepEqual(loadConfig(file, {}), { streamMode: "graph" });
  assert.deepEqual(loadConfig(file, { HERDR_SUBAGENT_STREAMER_STREAM_MODE: "tail" }), { streamMode: "tail" });
  fs.writeFileSync(file, JSON.stringify({ streamMode: "grid" }));
  assert.deepEqual(loadConfig(file, {}), { streamMode: "hybrid" });
});
