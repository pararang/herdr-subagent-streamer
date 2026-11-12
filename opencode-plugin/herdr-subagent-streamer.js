// opencode plugin: stream this pane's subagents into a herdr tab.
//
// opencode 2.x wants `export default { id, setup }`, and setup returns its own teardown.
// Rather than depend on the event surface, setup starts a small watcher that asks herdr which
// session this pane runs and waits for it to spawn a subagent. A pane that never spawns one
// costs a sleeping shell and nothing else.
//
// Install: copy or symlink this file into ~/.config/opencode/plugins/
// Override the checkout it runs from with HERDR_SUBAGENT_STREAMER_DIR.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.HERDR_SUBAGENT_STREAMER_DIR ?? path.resolve(here, "..");
const LAUNCHER = path.join(root, "bin", "streamer-here.sh");

const inHerdr = process.env.HERDR_ENV === "1";
const pane = process.env.HERDR_PANE_ID ?? "";

export default {
  id: "herdr-subagent-streamer",
  async setup() {
    if (!inHerdr || !pane || !fs.existsSync(LAUNCHER)) return () => {};

    const log = path.join(os.tmpdir(), "herdr-subagent-streamer", `${pane.replace(/\W/g, "_")}.watch.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const out = fs.openSync(log, "a");
    const child = spawn("bash", [LAUNCHER, "--watch", pane], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, STREAMER_HOST_PID: String(process.pid) },
    });
    child.on("error", (error) => fs.appendFileSync(log, `streamer-here: ${error.message}\n`));
    child.unref();

    return () => {
      try {
        process.kill(child.pid);
      } catch {}
    };
  },
};
