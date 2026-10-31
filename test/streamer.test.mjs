import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const streamer = fileURLToPath(new URL("../src/streamer.mjs", import.meta.url));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const message = (text) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";

const muxExecutable = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const home = process.env.STREAMER_TEST_HOME;
const eventsFile = path.join(home, "events.jsonl");
const stateFile = path.join(home, "mux.json");
const record = (event) => fs.appendFileSync(eventsFile, JSON.stringify(event) + "\n");
const events = () => fs.readFileSync(eventsFile, "utf8").split("\n").slice(0, -1).map(JSON.parse);

if (process.argv[2] === "--pane-worker") {
  const [pane, run, command] = process.argv.slice(3);
  const env = { ...process.env, HERDR_SUBAGENT_STREAMER_MUX: process.env.STREAMER_TEST_SERVER_MUX };
  const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["ignore", "pipe", "pipe"] });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  record({ type: "worker", pane, run, pid: process.pid, childPid: child.pid });
  child.stdout.on("data", (data) => record({ type: "output", pane, run, text: data.toString() }));
  child.stderr.on("data", (data) => record({ type: "stderr", pane, run, text: data.toString() }));
  child.on("error", (error) => record({ type: "worker-error", pane, run, message: error.message }));
  child.on("close", (code, signal) => record({ type: "exit", pane, run, code, signal }));
} else {
  const lock = path.join(home, "mux-lock");
  const deadline = Date.now() + 10000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  process.on("exit", () => fs.rmSync(lock, { recursive: true, force: true }));
  const backend = path.basename(process.argv[1]);
  const args = process.argv.slice(2);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const option = (name) => args[args.indexOf(name) + 1];
  const fail = (message) => { record({ type: "rejected", args, message }); console.error(message); process.exit(1); };
  const active = (pane) => pane.run && !events().some((event) => event.type === "exit" && event.run === pane.run);
  const paneAt = (id) => {
    const pane = state.panes[id];
    if (!pane || pane.defaultExited || !state.tabs[pane.tab]?.open) fail("pane is closed: " + id);
    if (pane.backend !== backend) fail("pane belongs to another multiplexer: " + id);
    if (backend === "tmux" && pane.run && !active(pane) && !pane.remain) fail("pane disappeared after command exit: " + id);
    return pane;
  };
  const start = (id, command, replaceIdle = false) => {
    const pane = paneAt(id);
    if (active(pane)) fail("cannot replace a running command in " + id);
    if (backend === "tmux" && pane.idle && !replaceIdle) fail("idle shell requires respawn-pane -k");
    const run = String(++state.nextRun);
    pane.run = run;
    pane.idle = false;
    record({ type: "run", pane: id, tab: pane.tab, run, label: pane.label, command });
    const worker = spawn(process.execPath, [__filename, "--pane-worker", id, run, command], { detached: true, stdio: "ignore", env: process.env });
    record({ type: "spawn", pane: id, run, pid: worker.pid });
    worker.unref();
  };
  const createPane = (tab, root = false) => {
    const id = "%" + ++state.nextPane;
    state.panes[id] = { tab, backend, label: "", idle: true, remain: false };
    record({ type: root ? "root" : "split", tab, pane: id });
    return id;
  };
  const createTab = (label) => {
    const id = "tab-" + ++state.nextTab;
    state.tabs[id] = { open: true, label };
    const pane = createPane(id, true);
    record({ type: "tab-open", tab: id, pane, label });
    return { id, pane };
  };
  const closeTab = (id) => {
    const tab = state.tabs[id] ? id : paneAt(id).tab;
    if (!state.tabs[tab]?.open) fail("tab is closed: " + tab);
    state.tabs[tab].open = false;
    record({ type: "tab-close", tab });
    for (const event of events()) {
      if (event.type === "spawn" && state.panes[event.pane]?.tab === tab) {
        try { process.kill(-event.pid, "SIGTERM"); } catch {}
      }
    }
  };
  const rename = (id, label) => { paneAt(id).label = label; record({ type: "label", pane: id, label }); };
  record({ type: "command", backend, args });
  let result;
  if (backend === "herdr") {
    const [entity, action, id] = args;
    if (entity === "tab" && action === "get") {
      if (id === "main") result = { tab: { tab_id: "main", label: "coding" } };
      else {
        if (!state.tabs[id]?.open) fail("tab is closed: " + id);
        result = { tab: { tab_id: id, label: state.tabs[id].label } };
      }
    } else if (entity === "tab" && action === "create") {
      const tab = createTab(option("--label"));
      result = { tab: { tab_id: tab.id }, root_pane: { pane_id: tab.pane } };
    } else if (entity === "tab" && action === "close") closeTab(id);
    else if (entity === "pane" && action === "split") result = { pane: { pane_id: createPane(paneAt(id).tab) } };
    else if (entity === "pane" && action === "rename") rename(id, args[3]);
    else if (entity === "pane" && action === "run") start(id, args[3]);
    else fail("unsupported herdr command: " + args.join(" "));
    console.log(JSON.stringify({ result: result ?? {} }));
  } else {
    const action = args[0];
    if (action === "new-window") {
      const tab = createTab(option("-n"));
      result = tab.pane;
      const command = args.at(-1);
      if (command !== option("-n")) start(tab.pane, command, true);
    } else if (action === "split-window") {
      const id = createPane(paneAt(option("-t")).tab);
      result = id;
      const command = args.at(-1);
      if (command === option("-t")) state.panes[id].defaultExited = true;
      else if (command !== "exec /bin/sh") start(id, command, true);
    } else if (action === "select-pane") rename(option("-t"), option("-T"));
    else if (action === "select-layout") paneAt(option("-t"));
    else if (["set-option", "set-window-option", "set"].includes(action)) {
      if (args.includes("remain-on-exit")) paneAt(option("-t")).remain = args.at(-1) === "on";
      else if (args.includes("remain-on-exit-format")) paneAt(option("-t"));
      else fail("unsupported tmux option");
    } else if (action === "respawn-pane") start(option("-t"), args.at(-1), args.includes("-k"));
    else if (action === "kill-window") closeTab(option("-t"));
    else if (action === "clear-history") { paneAt(option("-t")); record({ type: "clear-history", pane: option("-t") }); }
    else if (["display", "display-message"].includes(action)) {
      const id = option("-t");
      const pane = state.panes[id];
      result = id === "%main" ? "coding" : pane && !pane.defaultExited && state.tabs[pane.tab]?.open ? (paneAt(id), id) : "";
    } else fail("unsupported tmux command: " + args.join(" "));
    if (result) console.log(result);
  }
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
`;

function fixture(t, backend, mode, closeMs = 100) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hss-streamer-"));
  const bin = path.join(home, "bin");
  const eventsFile = path.join(home, "events.jsonl");
  const feed = path.join(home, "feed.jsonl");
  fs.mkdirSync(bin);
  fs.writeFileSync(eventsFile, "");
  fs.writeFileSync(feed, "");
  fs.writeFileSync(path.join(home, "mux.json"), JSON.stringify({ tabs: {}, panes: {}, nextPane: 0, nextTab: 0, nextRun: 0 }));
  for (const name of ["herdr", "tmux"]) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${muxExecutable}`, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    TMPDIR: home,
    STREAMER_TEST_HOME: home,
    STREAMER_TEST_SERVER_MUX: backend === "tmux" ? "herdr" : "tmux",
    HERDR_ENV: "0",
    HERDR_TAB_ID: "main",
    HERDR_WORKSPACE_ID: "test-workspace",
    TMUX: "test-only",
    TMUX_PANE: "%main",
    HERDR_SUBAGENT_STREAMER_MUX: backend,
    HERDR_SUBAGENT_STREAMER_STREAM_MODE: mode,
    HERDR_SUBAGENT_STREAMER_CLOSE_MS: String(closeMs),
  };
  const processes = [];
  let output = "";
  const events = () => fs.readFileSync(eventsFile, "utf8").split("\n").slice(0, -1).map((line) => JSON.parse(line));
  const raw = (pane) => events().filter((event) => event.type === "output" && event.pane === pane).map((event) => event.text).join("");
  const runOutput = (run) => events().filter((event) => event.type === "output" && event.run === run).map((event) => event.text).join("");
  const visible = (pane) => {
    const text = raw(pane);
    const cleared = Math.max(text.lastIndexOf("\x1b[2J"), text.lastIndexOf("\x1bc"));
    return text.slice(Math.max(0, cleared)).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|c)/g, "");
  };
  const history = (pane) => {
    let text = "";
    for (const event of events()) {
      if (event.pane !== pane) continue;
      if (event.type === "clear-history") text = "";
      else if (event.type === "output") text += event.text;
    }
    const cleared = Math.max(text.lastIndexOf("\x1b[3J"), text.lastIndexOf("\x1bc"));
    return text.slice(Math.max(0, cleared)).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|c)/g, "");
  };
  const waitFor = (description, predicate) => new Promise((resolve, reject) => {
    let watcher;
    let timer;
    const finish = (error, value) => {
      watcher?.close();
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const check = () => {
      try {
        const value = predicate(events());
        if (value) finish(null, value);
      } catch (error) { finish(error); }
    };
    watcher = fs.watch(home, check);
    timer = setTimeout(() => finish(new Error(`Timed out waiting for ${description}\n${output}\n${JSON.stringify(events().slice(-12), null, 2)}`)), 20000);
    check();
  });
  t.after(async () => {
    for (const child of processes) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
    for (const event of events()) {
      if (event.type === "spawn") {
        try { process.kill(-event.pid, "SIGKILL"); } catch {}
      }
    }
    await Promise.all(processes.map((child) => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise((resolve) => {
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    })));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    home, events, raw, runOutput, visible, history, waitFor,
    start() {
      const child = spawn(process.execPath, [streamer, "auto", encode({ host: "omp", session: "fixture-session", feed, pid: process.pid })], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      processes.push(child);
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      child.on("error", (error) => { output += error.stack; });
      return child;
    },
    async closeTab(tab) {
      const args = backend === "herdr" ? ["tab", "close", tab] : ["kill-window", "-t", tab];
      await new Promise((resolve, reject) => {
        const child = spawn(path.join(bin, backend), args, { env, stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`tab close exited ${code}`)));
      });
    },
    statuses(changes) {
      const lines = changes.map(([id, status]) => {
        const transcript = path.join(home, `${id}.jsonl`);
        if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, message(`${id}-initial`));
        return JSON.stringify({ id, status, agent: "worker", ts: Date.now(), sessionFile: transcript });
      });
      fs.appendFileSync(feed, lines.join("\n") + "\n");
    },
    status(id, status) { this.statuses([[id, status]]); },
    append(id, text) { fs.appendFileSync(path.join(home, `${id}.jsonl`), message(text)); },
    async running(id, afterRun = 0) {
      return waitFor(`${id} transcript`, (all) => all.find((event) => event.type === "run" && Number(event.run) > Number(afterRun)
        && runOutput(event.run).includes(`== ${id} ==`) && runOutput(event.run).includes(`${id}-initial`)
        && all.filter((label) => label.type === "label" && label.pane === event.pane).at(-1)?.label === id));
    },
    async exited(run) {
      const event = await waitFor(`follower ${run} exit`, (all) => all.find((event) => event.type === "exit" && event.run === run));
      assert.equal(event.code, 0);
      assert.equal(event.signal, null);
      return event;
    },
    assertClean() {
      assert.deepEqual(events().filter((event) => ["rejected", "worker-error"].includes(event.type)), []);
      assert.deepEqual(events().filter((event) => event.type === "stderr"), []);
    },
  };
}

for (const [backend, mode] of [["herdr", "hybrid"], ["tmux", "tail"]]) {
  test(`${backend} ${mode}: active worker panes drain, reuse, revive, and close`, { timeout: 90000 }, async (t) => {
    const f = fixture(t, backend, mode);
    for (const id of ["A", "B", "C"]) f.status(id, "started");
    f.status("D", "queued");
    f.status("E", "pending");
    f.status("NeverActive", "completed");
    f.status("Unknown", "unknown");
    const auto = f.start();
    const a = await f.running("A");
    const b = await f.running("B");
    const c = await f.running("C");
    const initialTab = a.tab;
    assert.equal(b.tab, initialTab);
    assert.equal(c.tab, initialTab);
    assert.equal(new Set([a.pane, b.pane, c.pane]).size, 3);
    const root = f.events().find((event) => event.type === "root" && event.tab === initialTab);
    assert.ok(root);
    assert.ok(![a.pane, b.pane, c.pane].includes(root.pane));
    if (mode === "tail") {
      await f.waitFor("historical and queued workers on the board", () => ["D", "E", "NeverActive"].every((id) => f.raw(root.pane).includes(id)));
    }

    const finalA = Array.from({ length: 256 }, (_, i) => `A-final-${i}-${"x".repeat(256)}`);
    for (const line of finalA) f.append("A", line);
    f.status("A", "completed");
    f.status("D", "started");
    const d = await f.running("D");
    assert.equal(d.pane, a.pane, "D must reuse A's physical pane");
    await f.exited(a.run);
    const aOutput = f.events().filter((event) => event.type === "output" && event.run === a.run).map((event) => event.text).join("");
    for (const line of finalA) assert.ok(aOutput.includes(line), `missing final record ${line.slice(0, 16)}`);
    assert.match(aOutput, /== completed ==/);
    assert.ok(f.events().findIndex((event) => event.type === "exit" && event.run === a.run) < f.events().findIndex((event) => event.type === "run" && event.run === d.run));
    assert.match(f.visible(d.pane), /== D ==/);
    assert.ok(!f.visible(d.pane).includes("A-initial"), "reassignment clears the previous viewport");
    assert.ok(!f.visible(d.pane).includes("A-final-"));
    assert.ok(!f.history(d.pane).includes("A-initial"), "reassignment clears the previous scrollback");
    assert.ok(!f.history(d.pane).includes("A-final-"));

    f.append("B", "B-last-record");
    f.status("B", "completed");
    f.status("E", "running");
    const e = await f.running("E");
    assert.equal(e.pane, b.pane, "E must reuse B's physical pane");
    await f.exited(b.run);
    assert.ok(f.events().some((event) => event.type === "output" && event.run === b.run && event.text.includes("B-last-record")));
    assert.match(f.visible(e.pane), /== E ==/);
    assert.ok(!f.visible(e.pane).includes("B-initial"));
    assert.ok(!f.history(e.pane).includes("B-initial"));

    f.status("D", "completed");
    await f.exited(d.run);
    f.append("A", "A-revived-output");
    f.status("A", "started");
    const revived = await f.running("A", a.run);
    await f.waitFor("revived transcript output", () => f.visible(revived.pane).includes("A-revived-output"));
    assert.equal(revived.pane, a.pane);
    assert.ok(!f.visible(revived.pane).includes("D-initial"));
    f.status("QueuedOnly", "queued");
    f.statuses([["Flash", "started"], ["Flash", "completed"]]);
    f.status("LateTerminal", "failed");
    for (const id of ["A", "C", "E"]) { f.append(id, `${id}-settled-last`); f.status(id, "completed"); }
    f.status("QueuedOnly", "cancelled");
    f.status("Unknown", "cancelled");
    for (const run of [revived.run, c.run, e.run]) await f.exited(run);
    await f.waitFor("all-settled tab closure", (all) => all.find((event) => event.type === "tab-close" && event.tab === initialTab));
    await f.waitFor("overview process exit", (all) => {
      const run = all.find((event) => event.type === "run" && event.pane === root.pane);
      return all.find((event) => event.type === "exit" && event.run === run?.run);
    });
    assert.equal(auto.exitCode, null, "the watcher stays alive while its host is alive");
    assert.equal(auto.signalCode, null);
    const firstTabEvents = f.events().filter((event) => event.tab === initialTab);
    assert.equal(firstTabEvents.filter((event) => event.type === "split").length, 3, "queued workers must not grow transcript capacity");
    assert.deepEqual(firstTabEvents.filter((event) => event.type === "run" && event.pane !== root.pane).map((event) => f.runOutput(event.run).match(/== ([A-E]) ==/)[1]), ["A", "B", "C", "D", "E", "A"]);
    for (const id of ["A", "C", "E"]) assert.ok(f.raw(id === "A" ? revived.pane : id === "C" ? c.pane : e.pane).includes(`${id}-settled-last`));

    f.append("A", "A-after-tab-close");
    f.status("A", "started");
    const reopened = await f.running("A", revived.run);
    assert.notEqual(reopened.tab, initialTab, "a settled id can reopen a closed tab");
    await f.waitFor("reopened transcript", () => f.visible(reopened.pane).includes("A-after-tab-close"));
    f.status("A", "completed");
    await f.exited(reopened.run);
    await f.waitFor("reopened tab closure", (all) => all.find((event) => event.type === "tab-close" && event.tab === reopened.tab));
    f.assertClean();
  });
}

for (const backend of ["herdr", "tmux"]) {
  test(`${backend} graph: history remains in the graph without transcript panes`, { timeout: 30000 }, async (t) => {
    const f = fixture(t, backend, "graph");
    f.status("Active", "running");
    f.status("Queued", "queued");
    f.status("Finished", "completed");
    f.start();
    const tab = await f.waitFor("graph tab", (all) => all.find((event) => event.type === "tab-open"));
    await f.waitFor("active, queued, and historical graph cards", () => ["Active", "Queued", "Finished"].every((id) => f.raw(tab.pane).includes(id)));
    f.status("Active", "completed");
    f.status("Queued", "cancelled");
    await f.waitFor("graph tab closure", (all) => all.find((event) => event.type === "tab-close"));
    await f.waitFor("graph command exit", (all) => {
      const run = all.find((event) => event.type === "run" && event.pane === tab.pane);
      return all.find((event) => event.type === "exit" && event.run === run?.run);
    });
    assert.equal(f.events().filter((event) => event.type === "split").length, 0);
    assert.equal(f.events().filter((event) => event.type === "run").length, 1);
    assert.ok(!f.raw(tab.pane).includes("Active-initial"), "graph mode must not run a transcript follower");
    f.assertClean();
  });
}

test("tmux tail: a closed window reopens for the next active worker", { timeout: 45000 }, async (t) => {
  const f = fixture(t, "tmux", "tail", 0);
  f.status("A", "started");
  f.start();
  const a = await f.running("A");
  await f.closeTab(a.tab);
  f.statuses([["A", "completed"], ["B", "started"]]);
  const b = await f.running("B", a.run);
  assert.notEqual(b.tab, a.tab);
  assert.notEqual(b.pane, a.pane);
  assert.ok(f.visible(b.pane).includes("B-initial"));
  f.status("B", "completed");
  await f.exited(b.run);
});
