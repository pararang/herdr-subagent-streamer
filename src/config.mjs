// User config: $XDG_CONFIG_HOME/herdr-subagent-streamer/config.json (default ~/.config/...).
//   { "streamMode": "tail" | "graph" }
// HERDR_SUBAGENT_STREAMER_STREAM_MODE overrides the file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STREAM_MODES = ["tail", "graph"];
const DEFAULTS = { streamMode: "tail" };

export const configFile = (env = process.env) =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr-subagent-streamer", "config.json");

export function loadConfig(file = configFile(), env = process.env) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") console.error(`ignoring ${file}: ${e.message}`); }
  const streamMode = env.HERDR_SUBAGENT_STREAMER_STREAM_MODE ?? raw.streamMode ?? DEFAULTS.streamMode;
  if (STREAM_MODES.includes(streamMode)) return { streamMode };
  console.error(`unknown streamMode ${JSON.stringify(streamMode)} (expected ${STREAM_MODES.join(" or ")}): using ${DEFAULTS.streamMode}`);
  return { ...DEFAULTS };
}
