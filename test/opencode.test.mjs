import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hss-opencode-"));
const dbFile = path.join(home, "opencode.db");
const tmpDir = path.join(home, "tmp");
fs.mkdirSync(tmpDir);
process.env.OPENCODE_DB = dbFile;
process.env.TMPDIR = tmpDir;

const db = new DatabaseSync(dbFile);
db.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, parent_id text, title text, agent text, time_created integer, time_updated integer);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);`);

const now = Date.now();
const insertSession = db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?,?)");
const insertMessage = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)");
const updateMessage = db.prepare("UPDATE session_message SET data = ? WHERE id = ?");

const add = (session, seq, type, data, at = now) => insertMessage.run(`${session}-${seq}`, session, type, seq, at, at, JSON.stringify(data));
const user = (text, at = now) => ({ text, time: { created: at } });
const assistant = (content, completed = true) => ({ content, time: completed ? { created: now, completed: now } : { created: now } });
const tool = (status, extra = {}) => ({ type: "tool", id: "call1", name: "bash", state: { status, input: { command: "ls" }, content: [], ...extra } });

const { transcriptFor, childSessions, sessionStatus } = await import("../src/opencode.mjs");
const { opencodeHost } = await import("../src/hosts.mjs");

const messages = (text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line).message);
const read = (file) => messages(fs.readFileSync(file, "utf8"));
const roles = (file) => read(file).map((m) => m.role);

test("each process gets its own transcript with one copy of every record", () => {
  add("dup", 0, "user", user("list files"));
  add("dup", 1, "assistant", assistant([{ type: "text", text: "two files" }]));
  add("dup", 2, "idle", { outcome: "succeeded" });
  const pass = `import fs from "node:fs";
const { transcriptFor } = await import(${JSON.stringify(new URL("../src/opencode.mjs", import.meta.url).href)});
process.stdout.write(fs.readFileSync(transcriptFor("dup"), "utf8"));`;
  const runPass = () => {
    const out = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", pass], { env: process.env, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return messages(out.stdout).map((m) => m.role);
  };
  assert.deepEqual(runPass(), ["user", "assistant"], "first process");
  assert.deepEqual(runPass(), ["user", "assistant"], "second process");
});

test("the next process removes transcripts left by a killed process and keeps live ones", async (t) => {
  add("swept", 0, "user", user("hello"));
  const holder = `const { transcriptFor } = await import(${JSON.stringify(new URL("../src/opencode.mjs", import.meta.url).href)});
console.log(transcriptFor("swept")); setInterval(() => {}, 1000);`;
  const start = async () => {
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", holder], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
    const [line] = await once(child.stdout, "data");
    return { child, dir: path.dirname(line.toString().trim()) };
  };
  const live = await start();
  t.after(() => live.child.kill());
  const killed = await start();
  killed.child.kill("SIGKILL");
  await once(killed.child, "exit");
  assert.ok(fs.existsSync(killed.dir), "a killed process leaves its transcripts behind");

  const next = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", holder.replace("setInterval(() => {}, 1000);", "")], { env: process.env, encoding: "utf8" });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(fs.existsSync(killed.dir), false, "the next process swept the dead pid's transcripts");
  assert.ok(fs.existsSync(live.dir), "a running process keeps its transcripts");
});

test("a tool that completes after a newer message exists still yields its result", () => {
  add("late", 0, "user", user("list files"));
  add("late", 1, "assistant", assistant([tool("running")], false));
  add("late", 2, "system", { text: "note" });
  const file = transcriptFor("late");
  assert.deepEqual(roles(file), ["user"]);

  updateMessage.run(JSON.stringify(assistant([tool("completed", { content: [{ type: "text", text: "a.txt" }, { type: "text", text: "b.txt" }] })])), "late-1");
  transcriptFor("late");
  const recs = read(file);
  assert.deepEqual(recs.map((m) => m.role), ["user", "assistant", "toolResult"]);
  assert.deepEqual(recs[1].content, [{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "ls" } }]);
  assert.deepEqual(recs[2], { role: "toolResult", toolCallId: "call1", isError: false, content: [{ type: "text", text: "a.txt\nb.txt" }] });
});

test("an errored tool yields an error result with its message", () => {
  add("err", 0, "user", user("run it"));
  add("err", 1, "assistant", assistant([tool("error", { error: { type: "tool.execution", message: "command not found" } })]));
  const recs = read(transcriptFor("err"));
  assert.deepEqual(recs.at(-1), { role: "toolResult", toolCallId: "call1", isError: true, content: [{ type: "text", text: "command not found" }] });
});

test("an assistant message streams out only once it completes", () => {
  add("stream", 0, "user", user("hello"));
  add("stream", 1, "assistant", assistant([{ type: "text", text: "Hel" }], false));
  const file = transcriptFor("stream");
  assert.deepEqual(roles(file), ["user"]);
  transcriptFor("stream");
  assert.deepEqual(roles(file), ["user"], "still streaming");

  updateMessage.run(JSON.stringify(assistant([{ type: "text", text: "Hello there" }])), "stream-1");
  transcriptFor("stream");
  transcriptFor("stream");
  assert.deepEqual(read(file), [{ role: "user", content: [{ type: "text", text: "hello" }] }, { role: "assistant", content: [{ type: "text", text: "Hello there" }] }]);
});

test("an abandoned assistant message is emitted once the session goes idle", () => {
  add("gone", 0, "user", user("hello"));
  add("gone", 1, "assistant", assistant([{ type: "text", text: "Hel" }], false));
  const file = transcriptFor("gone");
  assert.deepEqual(roles(file), ["user"]);

  add("gone", 2, "idle", { outcome: "aborted" });
  transcriptFor("gone");
  assert.deepEqual(read(file), [{ role: "user", content: [{ type: "text", text: "hello" }] }, { role: "assistant", content: [{ type: "text", text: "Hel" }] }]);
});

test("the main transcript starts at the launch time, not the session's history", () => {
  add("root", 0, "user", user("old prompt", now - 60000), now - 60000);
  add("root", 1, "assistant", assistant([{ type: "text", text: "old answer" }]), now - 60000);
  add("root", 2, "user", user("new prompt"));
  add("root", 3, "assistant", assistant([{ type: "text", text: "new answer" }]));
  const recs = read(opencodeHost("root", now - 1000).mainTranscript());
  assert.deepEqual(recs.map((m) => m.content[0].text), ["new prompt", "new answer"]);
});

test("child sessions since launch are listed and settle when they go idle", () => {
  insertSession.run("kid-old", "parent", "old", "explore", now - 60000, now - 60000);
  insertSession.run("kid", "parent", "scan", "explore", now, now);
  add("kid", 0, "user", user("scan"));
  assert.deepEqual(childSessions("parent", now - 1000).map((t) => [t.id, t.status]), [["kid", "running"]]);
  assert.equal(sessionStatus("kid"), "running");

  add("kid", 1, "idle", { outcome: "succeeded" });
  assert.equal(sessionStatus("kid"), "completed");
});

test("a session with no messages runs, and a non-success idle outcome fails it", () => {
  insertSession.run("quiet", "p2", "quiet", "explore", now, now);
  insertSession.run("bad", "p2", "bad", "explore", now, now);
  add("bad", 0, "idle", { outcome: "aborted" }, now + 5);
  assert.deepEqual(childSessions("p2").map((t) => [t.id, t.status, t.ended]), [
    ["quiet", "running", undefined],
    ["bad", "failed", new Date(now + 5).toISOString()],
  ]);
});
