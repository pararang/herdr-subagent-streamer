export function selfCommand(executable, script, platform) {
  // shortcut: assumes PowerShell on Windows and POSIX shells elsewhere; detect the shell if mixed-shell panes are supported.
  const windows = platform === "win32";
  const q = (s) => `'${String(s).replace(/'/g, windows ? "''" : `'\\''`)}'`;
  return `${windows ? "& " : ""}${q(executable)} ${q(script)}`;
}
