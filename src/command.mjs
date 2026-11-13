export function selfCommand(executable, script, platform) {
  // shortcut: assumes PowerShell on Windows and POSIX shells elsewhere; detect the shell if mixed-shell panes are supported.
  const windows = platform === "win32";
  const q = (s) => `'${String(s).replace(/'/g, windows ? "''" : `'\\''`)}'`;
  return `${windows ? "& " : ""}${q(executable)} ${q(script)}`;
}

// Streamer arguments are base64url JSON, which survives every shell's quoting untouched.
export const encodeArg = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
export const decodeArg = (arg) => JSON.parse(Buffer.from(arg, "base64url").toString());
