import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "hss-launch-"));
const { existingStreamer, paneFiles } = await import("../src/launch.mjs");

const sleeper = (t) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  return child;
};
const deadPid = async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid;
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidFile = (pane, record) => {
  fs.mkdirSync(paneFiles(pane).dir, { recursive: true });
  fs.writeFileSync(paneFiles(pane).pid, JSON.stringify(record));
};

test("a streamer owned by another live agent keeps running", (t) => {
  const streamer = sleeper(t), otherAgent = sleeper(t);
  pidFile("a", { pid: streamer.pid, owner: otherAgent.pid, session: "S1" });
  assert.equal(existingStreamer({ pane: "a", owner: process.pid, session: "S2" }), streamer.pid);
});

test("an agent starting a new session replaces its own streamer", async (t) => {
  const streamer = sleeper(t);
  pidFile("b", { pid: streamer.pid, owner: process.pid, session: "S1" });
  assert.equal(existingStreamer({ pane: "b", owner: process.pid, session: "S1" }), streamer.pid, "same session keeps it");
  assert.equal(existingStreamer({ pane: "b", owner: process.pid, session: "S2" }), null);
  await once(streamer, "exit");
});

test("a streamer whose agent has exited is replaced", async (t) => {
  const streamer = sleeper(t);
  pidFile("c", { pid: streamer.pid, owner: await deadPid(), session: "S1" });
  assert.equal(existingStreamer({ pane: "c", owner: process.pid, session: "S1" }), null);
  await once(streamer, "exit");
});

test("a hand-started streamer is kept for its session and replaced for another", async (t) => {
  const streamer = sleeper(t);
  pidFile("d", { pid: streamer.pid, session: "S1" });
  assert.equal(existingStreamer({ pane: "d", session: "S1" }), streamer.pid);
  assert.equal(existingStreamer({ pane: "d", session: "S2" }), null);
  await once(streamer, "exit");
  assert.equal(alive(streamer.pid), false);
});

test("a dead streamer or no pid file starts fresh", async () => {
  assert.equal(existingStreamer({ pane: "none", session: "S1" }), null);
  pidFile("e", { pid: await deadPid(), session: "S1" });
  assert.equal(existingStreamer({ pane: "e", session: "S1" }), null);
});
