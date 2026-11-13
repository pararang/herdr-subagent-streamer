// Multiplexer adapters: herdr and tmux behind one interface.
//   mainTabLabel()          -> name of the tab the main agent runs in
//   openTab(label, cmd)     -> { tab, pane }   tab runs cmd in its root pane, without taking focus
//   openPane(from, i)       -> pane            an idle pane split off `from`
//   run(pane, cmd)          start cmd in a pane whose previous command has exited
//   retitle(pane, label)    title a pane and drop its scrollback (called from inside the pane)
//   closeTab(tab), closePane(pane), hasTab(tab), hasPane(pane)
import { spawnSync } from "node:child_process";

export const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || r.error || "").toString().trim()}`);
  return r.stdout.trim();
};
const succeeds = (fn) => { try { fn(); return true; } catch { return false; } };

function herdr() {
  const json = (...a) => JSON.parse(run("herdr", a)).result;
  const mux = {
    mainTabLabel: () => json("tab", "get", process.env.HERDR_TAB_ID ?? "").tab.label,
    openTab(label, cmd) {
      const r = json("tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID ?? "", "--label", label, "--no-focus");
      try {
        run("herdr", ["pane", "run", r.root_pane.pane_id, cmd]);
        return { pane: r.root_pane.pane_id, tab: r.tab.tab_id };
      } catch (error) {
        try { mux.closeTab(r.tab.tab_id); }
        catch (cleanupError) { console.error(`tab cleanup failed: ${cleanupError.message}`); }
        throw error;
      }
    },
    // Alternate right/down so a fan-out stays a grid.
    openPane: (from, i) => json("pane", "split", from, "--direction", i % 2 ? "right" : "down", "--no-focus", "--cwd", process.cwd()).pane.pane_id,
    run: (pane, cmd) => run("herdr", ["pane", "run", pane, cmd]),
    retitle: (pane, label) => run("herdr", ["pane", "rename", pane, label]),
    closeTab: (tab) => run("herdr", ["tab", "close", tab]),
    closePane: (pane) => run("herdr", ["pane", "close", pane]),
    hasTab: (tab) => succeeds(() => json("tab", "get", tab)),
    hasPane: (pane) => succeeds(() => json("pane", "get", pane)),
  };
  return mux;
}

// A tmux pane disappears when its command exits, so a transcript pane starts as an idle shell and its
// first command replaces that shell with remain-on-exit set; later commands respawn the exited pane.
function tmux() {
  const idle = new Set();
  const hasPane = (pane) => succeeds(() => { if (run("tmux", ["display", "-p", "-t", pane, "#{pane_id}"]) !== pane) throw new Error(); });
  return {
    mainTabLabel: () => run("tmux", ["display", "-p", "-t", process.env.TMUX_PANE ?? "", "#{window_name}"]),
    // The window is addressed by its root pane: kill-window -t <pane> closes the window holding it.
    openTab(label, cmd) {
      const pane = run("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", label, cmd]);
      return { pane, tab: pane };
    },
    openPane(from) {
      const pane = run("tmux", ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", from, "exec /bin/sh"]);
      idle.add(pane);
      return pane;
    },
    run(pane, cmd) {
      const fresh = idle.has(pane);
      if (fresh) {
        run("tmux", ["set-option", "-p", "-t", pane, "remain-on-exit", "on"]);
        try { run("tmux", ["set-option", "-p", "-t", pane, "remain-on-exit-format", ""]); }
        catch (error) { console.error(`pane status format unavailable: ${error.message}`); }
        run("tmux", ["select-layout", "-t", pane, "tiled"]);
        idle.delete(pane);
      }
      run("tmux", ["respawn-pane", ...(fresh ? ["-k"] : []), "-t", pane, cmd]);
    },
    retitle(pane, label) {
      run("tmux", ["clear-history", "-t", pane]);
      run("tmux", ["select-pane", "-t", pane, "-T", label]);
    },
    closeTab: (tab) => run("tmux", ["kill-window", "-t", tab]),
    closePane: (pane) => run("tmux", ["kill-pane", "-t", pane]),
    hasTab: hasPane,
    hasPane,
  };
}

const ADAPTERS = { herdr, tmux };

export const detectMux = (env = process.env) =>
  env.HERDR_SUBAGENT_STREAMER_MUX ?? (env.HERDR_ENV === "1" ? "herdr" : env.TMUX ? "tmux" : "");
export const muxFor = (name) => ADAPTERS[name]?.();
