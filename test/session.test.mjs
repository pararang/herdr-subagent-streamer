import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSession } from "../src/session.mjs";
import { createFollowers } from "../src/follower.mjs";

function fakeMux() {
  const tabs = new Map(), panes = new Map(), shown = new Map();
  let n = 0;
  return {
    tabs, panes, shown,
    paneCount: () => [...panes.values()].filter((p) => !p.root).length,
    mainTabLabel: () => "coding",
    openTab(label) {
      const tab = `tab${++n}`, pane = `pane${++n}`;
      tabs.set(tab, label);
      panes.set(pane, { tab, root: true });
      return { tab, pane };
    },
    openPane(from) {
      const pane = `pane${++n}`;
      panes.set(pane, { tab: panes.get(from).tab });
      return pane;
    },
    run(pane, taskId) { shown.set(pane, taskId); },
    closeTab(tab) {
      tabs.delete(tab);
      for (const [id, p] of panes) if (p.tab === tab) panes.delete(id);
    },
    closePane(pane) { panes.delete(pane); },
    hasTab: (tab) => tabs.has(tab),
    hasPane: (pane) => panes.has(pane),
  };
}

// Followers that behave like real ones: printing while their task is active, drained once it is not
// or once an agent whose subagents die with it has exited.
function setup({ transcripts = true, diesWithAgent = false, closeAfterMs = 100 } = {}) {
  let clock = Date.parse("2026-01-01"), hostAlive = true;
  const statuses = new Map(), failed = new Set(), draining = new Set();
  const mux = fakeMux();
  const host = { diesWithAgent, list: () => [...statuses].map(([id, status]) => ({ id, name: id, status })) };
  const followers = {
    create: (task) => ({
      taskId: task.id,
      start: (pane) => mux.run(pane, task.id),
      state: () => failed.has(task.id) ? { phase: "failed", reason: "boom" }
        : draining.has(task.id) ? { phase: "running" }
        : ["started", "running"].includes(statuses.get(task.id)) && (hostAlive || !diesWithAgent) ? { phase: "running" } : { phase: "drained" },
      release() {},
    }),
  };
  const log = { log() {}, error() {} };
  const session = createSession({
    host, mux, followers, rootCommand: "root", transcripts, modeName: "test",
    hostPid: 1, closeAfterMs, alive: () => hostAlive, now: () => clock, log,
  });
  return {
    mux, session, failed, draining,
    set: (entries) => { for (const [id, status] of Object.entries(entries)) statuses.set(id, status); },
    tick: (ms = 0) => { clock += ms; return session.tick(); },
    hostExits: () => { hostAlive = false; },
    paneOf: (id) => [...mux.shown].findLast(([pane, shown]) => shown === id && mux.panes.has(pane))?.[0],
  };
}

test("only active workers get transcript panes, and panes grow to the peak active count", () => {
  const s = setup();
  s.set({ A: "started", B: "running", Q: "queued", P: "pending", U: "unknown", Done: "completed" });
  s.tick();
  assert.equal(s.mux.tabs.size, 1);
  assert.deepEqual([...s.mux.tabs.values()], ["coding-subagents"]);
  assert.equal(s.mux.paneCount(), 2);
  assert.deepEqual(new Set(s.mux.shown.values()), new Set(["A", "B"]));
});

test("a finished worker's pane goes to the next active worker only after its follower drains", () => {
  const s = setup();
  s.set({ A: "started" });
  s.tick();
  const pane = s.paneOf("A");
  s.draining.add("A");
  s.set({ A: "completed", B: "started" });
  s.tick();
  assert.equal(s.paneOf("B"), undefined, "B waits for A's follower");
  assert.equal(s.mux.paneCount(), 1, "no pane grows past the peak active count");
  s.draining.delete("A");
  s.tick();
  assert.equal(s.paneOf("B"), pane, "B reuses A's pane");
  assert.equal(s.mux.paneCount(), 1);
});

test("a revived worker gets back the pane it last held", () => {
  const s = setup();
  s.set({ A: "started", B: "started" });
  s.tick();
  const [a, b] = [s.paneOf("A"), s.paneOf("B")];
  s.set({ A: "completed", B: "completed" });
  s.tick();
  s.set({ B: "running" });
  s.tick();
  assert.equal(s.paneOf("B"), b);
  s.set({ A: "running" });
  s.tick();
  assert.equal(s.paneOf("A"), a);
});

test("the tab closes once everything has settled for the close delay, and new work reopens it", () => {
  const s = setup({ closeAfterMs: 100 });
  s.set({ A: "started" });
  s.tick();
  s.set({ A: "completed" });
  s.tick(10);
  s.tick(50);
  assert.equal(s.mux.tabs.size, 1, "still inside the close delay");
  s.tick(100);
  assert.equal(s.mux.tabs.size, 0);
  s.set({ B: "started" });
  s.tick();
  assert.equal(s.mux.tabs.size, 1);
  assert.ok(s.paneOf("B"));
});

test("a failed follower's pane is destroyed, not handed to another worker", () => {
  const s = setup();
  s.set({ A: "started" });
  s.tick();
  const pane = s.paneOf("A");
  s.failed.add("A");
  s.set({ A: "completed", B: "started" });
  s.tick();
  assert.equal(s.mux.panes.has(pane), false);
  s.tick();
  assert.notEqual(s.paneOf("B"), pane);
});

test("graph mode opens the tab without transcript panes", () => {
  const s = setup({ transcripts: false });
  s.set({ A: "running", Q: "queued" });
  s.tick();
  assert.equal(s.mux.tabs.size, 1);
  assert.equal(s.mux.paneCount(), 0);
});

test("settled history at startup does not open the tab, a closed tab reopens on the next activity", () => {
  const s = setup();
  s.set({ Old: "completed" });
  s.tick();
  assert.equal(s.mux.tabs.size, 0);
  s.set({ A: "started" });
  s.tick();
  const [tab] = s.mux.tabs.keys();
  s.mux.closeTab(tab);
  s.tick();
  assert.equal(s.mux.tabs.size, 0, "a user-closed tab stays closed while nothing new happens");
  s.set({ A: "completed", B: "started" });
  s.tick();
  assert.equal(s.mux.tabs.size, 1);
  assert.notEqual([...s.mux.tabs.keys()][0], tab);
});

test("when the agent exits, subagents that die with it settle and the session ends after the tab closes", () => {
  const s = setup({ diesWithAgent: true });
  s.set({ A: "running" });
  s.tick();
  s.hostExits();
  assert.equal(s.tick(), false, "the tab is still open");
  s.tick(200);
  assert.equal(s.mux.tabs.size, 0);
  assert.equal(s.tick(), true);
});

test("subagents that outlive the agent keep the session alive until they settle", () => {
  const s = setup({ diesWithAgent: false });
  s.set({ A: "running" });
  s.tick();
  s.hostExits();
  s.tick(200);
  assert.equal(s.mux.tabs.size, 1);
  s.set({ B: "started" });
  s.tick();
  assert.ok(s.paneOf("B"), "a subagent spawned by a surviving subagent still gets a pane");
  s.set({ A: "completed", B: "completed" });
  s.tick();
  s.tick(200);
  assert.equal(s.tick(), true);
});

test("a follower is running until its receipt says drained, and failed when it dies first or never reports", () => {
  let clock = 0;
  const assignments = [];
  const live = new Set();
  const followers = createFollowers({
    mux: { run() {} }, backend: "herdr", command: (a) => { assignments.push(a); return ""; },
    now: () => clock, alive: (pid) => live.has(pid),
  });
  const receipt = (a, phase, pid, extra = {}) => fs.writeFileSync(a.receiptPath, JSON.stringify({ token: a.token, pid, phase, ...extra }));
  try {
    const ok = followers.create({ id: "A", name: "A", spec: {} });
    ok.start("pane1");
    assert.deepEqual(ok.state(), { phase: "running" }, "starting");
    receipt(assignments[0], "started", 7);
    live.add(7);
    assert.deepEqual(ok.state(), { phase: "running" });
    receipt(assignments[0], "drained", 7);
    assert.deepEqual(ok.state(), { phase: "running" }, "drained but still exiting");
    live.delete(7);
    assert.deepEqual(ok.state(), { phase: "drained" });

    const crashed = followers.create({ id: "B", name: "B", spec: {} });
    crashed.start("pane2");
    receipt(assignments[1], "started", 8);
    assert.deepEqual(crashed.state(), { phase: "failed", reason: "exited without final drain" });

    const silent = followers.create({ id: "C", name: "C", spec: {} });
    silent.start("pane3");
    clock += 10000;
    assert.deepEqual(silent.state(), { phase: "failed", reason: "startup receipt missing" });

    ok.release();
    assert.equal(fs.existsSync(assignments[0].receiptPath), false);
  } finally {
    followers.dispose();
  }
  assert.equal(fs.existsSync(assignments[0].receiptPath.replace(/[^/]+$/, "")), false);
});
