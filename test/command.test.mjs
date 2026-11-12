import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selfCommand } from "../src/command.mjs";

test("Windows commands use PowerShell literal strings and the call operator", () => {
  assert.equal(
    selfCommand(String.raw`C:\Program Files\O'Brien\node.exe`, String.raw`C:\my scripts\it's here\streamer.mjs`, "win32"),
    String.raw`& 'C:\Program Files\O''Brien\node.exe' 'C:\my scripts\it''s here\streamer.mjs'`,
  );
});

test("POSIX commands retain single-quote escaping", () => {
  const executable = String.raw`/opt/O'Brien/node program\bin`;
  const script = String.raw`/tmp/my scripts/it's here\streamer.mjs`;
  const expected = String.raw`'/opt/O'\''Brien/node program\bin' '/tmp/my scripts/it'\''s here\streamer.mjs'`;
  assert.equal(selfCommand(executable, script, "linux"), expected);
  assert.equal(selfCommand(executable, script, "darwin"), expected);
});

for (const shell of ["pwsh", "powershell", "sh"]) {
  test(`${shell} command preserves native arguments and payload`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr O'Brien "));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, "it's a script.mjs");
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const payload = Buffer.from(JSON.stringify({ text: "space, apostrophe's, and \\ backslash" })).toString("base64url");
    const executable = shell === "sh" && process.platform === "win32" ? process.execPath.replaceAll("\\", "/") : process.execPath;
    const scriptArgument = shell === "sh" && process.platform === "win32" ? script.replaceAll("\\", "/") : script;
    const command = `${selfCommand(executable, scriptArgument, shell === "sh" ? "linux" : "win32")} graph ${payload}`;
    const args = shell === "sh"
      ? ["-c", command]
      : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${command}; exit $LASTEXITCODE`];
    const result = spawnSync(shell, args, { encoding: "utf8" });
    if (result.error?.code === "ENOENT") {
      t.skip(`${shell} shell is unavailable`);
      return;
    }
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["graph", payload]);
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), { text: "space, apostrophe's, and \\ backslash" });
  });
}
