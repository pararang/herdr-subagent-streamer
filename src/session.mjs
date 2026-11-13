// Session: one agent session's subagents, mirrored into one multiplexer tab.
//   tick()   one poll: reap followers, read the host, open/recover the tab, fill slots, close when settled.
//            Returns true once the agent has exited, the tab is closed and every subagent has settled.
//   close()  close the tab, if open.
// A slot is one transcript pane. Slots grow only to the peak number of active workers, and a free
// slot goes to the worker it last showed before any other, so a revived worker keeps its pane.
import { TERMINAL, isActive } from "./hosts.mjs";

export function createSession({ host, mux, followers, rootCommand, transcripts, modeName, hostPid, closeAfterMs, alive, now = Date.now, log = console }) {
  const wasActive = new Map();
  let tab = "", rootPane = "", slots = [], peakActive = 0, allDoneAt = 0, openRequested = false, first = true;

  const forgetTab = () => {
    for (const slot of slots) slot.follower?.release();
    tab = rootPane = ""; slots = []; peakActive = 0; allDoneAt = 0; openRequested = false;
  };

  function reap() {
    for (const slot of [...slots]) {
      const f = slot.follower;
      if (!f) continue;
      const state = f.state();
      if (state.phase === "running") continue;
      if (state.phase === "drained") {
        f.release();
        slot.lastId = f.taskId;
        slot.follower = null;
        continue;
      }
      log.error(`follower failed for ${f.taskId}: ${state.reason}`);
      // A failed drain is not reusable. Destroy its pane instead of handing its output to another task.
      try { mux.closePane(slot.paneId); }
      catch (error) {
        if (mux.hasPane(slot.paneId)) { log.error(`pane cleanup failed: ${error.message}`); continue; }
      }
      f.release();
      slots.splice(slots.indexOf(slot), 1);
    }
  }

  function fill(active) {
    peakActive = Math.max(peakActive, active.length);
    for (const t of active) {
      if (slots.some((s) => s.follower?.taskId === t.id)) continue;
      let slot = slots.find((s) => !s.follower && s.lastId === t.id) ??
        slots.find((s) => !s.follower && !active.some((worker) => worker.id === s.lastId));
      try {
        if (!slot && slots.length < peakActive) {
          const from = slots.at(-1)?.paneId ?? rootPane;
          slot = { paneId: mux.openPane(from, slots.length + 1), follower: null };
          slots.push(slot);
        }
        if (!slot) continue;
        // Assigned before it starts: a follower that never reports is reaped with its pane.
        slot.follower = followers.create(t);
        slot.follower.start(slot.paneId);
        allDoneAt = 0;
        log.log(`${modeName}: added ${t.id}`);
      } catch (error) { log.error(`failed for ${t.id}: ${error.message}`); }
    }
  }

  function tick() {
    reap();
    const tasks = host.list();
    const hostGone = hostPid && !alive(hostPid);
    const settled = (t) => TERMINAL.includes(t.status) || (hostGone && host.diesWithAgent);
    const active = tasks.filter((t) => isActive(t.status) && !settled(t));
    // A new task, or a known one turning active, opens the tab. At startup, history that has already
    // settled does not.
    const wake = tasks.some((t) => !wasActive.has(t.id) ? !first || !settled(t) : isActive(t.status) && !wasActive.get(t.id));
    for (const t of tasks) wasActive.set(t.id, isActive(t.status));
    first = false;

    if (tab && !mux.hasTab(tab)) forgetTab();
    if (wake) openRequested = true;
    if (!tab && openRequested) {
      try {
        ({ tab, pane: rootPane } = mux.openTab(`${mux.mainTabLabel()}-subagents`, rootCommand));
        openRequested = false;
      } catch (error) { log.error(`tab open failed: ${error.message}`); }
    }
    if (tab && transcripts) fill(active);
    if (tab && closeAfterMs > 0) {
      if (!tasks.every(settled) || slots.some((s) => s.follower)) allDoneAt = 0;
      else if (!allDoneAt) allDoneAt = now();
      else if (now() - allDoneAt >= closeAfterMs) {
        try { mux.closeTab(tab); } catch (error) { log.error(`close failed: ${error.message}`); }
        log.log("all subagents done: closed tab");
        forgetTab();
      }
    }
    return Boolean(hostGone && !tab && tasks.every(settled));
  }

  return { tick, close: () => { if (tab) mux.closeTab(tab); } };
}
