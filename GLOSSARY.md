# Subagent streaming

Mirrors one coding agent session's subagents into a terminal multiplexer tab, so a person can watch them work.

## Language

### Agents

**Agent**:
The coding agent a person runs in a pane, whose session spawns the subagents.
_Avoid_: main, parent process

**Subagent**:
A child session the agent spawns to do delegated work. The host's record of one is a task.
_Avoid_: child, task (for the session itself)

**Worker**:
A subagent that is active, meaning started or running.
_Avoid_: running task, live subagent

**Settled**:
A subagent that has finished: its status is terminal, or its agent has exited and it cannot outlive that agent.
_Avoid_: done, finished, inactive

**Host**:
The coding agent program the session runs in (omo native, OMP or opencode). It decides where subagent records and transcripts live.
_Avoid_: harness, provider

**Transcript**:
The ordered record of one session's prompts, thinking, tool calls and results, as JSONL.
_Avoid_: log, history, session file

**Turn**:
One stretch of an agent's work between a prompt and the reply that hands control back. A turn ends with an assistant message that makes no tool call.

### Display

**Multiplexer**:
The terminal program that holds the panes: herdr or tmux.
_Avoid_: mux backend, terminal

**Subagents tab**:
The one multiplexer tab per session that shows its subagents, named after the agent's tab with a `-subagents` suffix.
_Avoid_: window, overview

Shown here beside the agent's tab, in `tail` mode:

```
tab "1"               tab "1-subagents"
+-----------------+   +-------------------+-------------------+
| main agent      |   | board (status)    | scout   (live)    |
|                 |   |                   +-------------------+
|                 |   |                   | fixer   (live)    |
+-----------------+   +-------------------+-------------------+
```

**Stream mode**:
Which panes the subagents tab holds: `hybrid` (graph and transcript panes), `tail` (board and transcript panes) or `graph` (graph only).

The `tail` layout is drawn above. The `hybrid` layout puts the graph in the root pane instead of the board:

```
tab "1-subagents" (hybrid)
+-------------------+-------------------+
| graph             | scout   (live)    |
|                   +-------------------+
|                   | fixer   (live)    |
+-------------------+-------------------+
```

In `graph` mode the graph is the tab's only pane.

**Graph**:
The root pane that draws the agent and its subagents as cards joined by spawn and message edges. The agent is on top, spawn edges run down to each subagent (nested ones under the subagent that spawned them), and `task_send` messages between subagents are drawn as magenta `├─▶` edges. Edges animate while their agent is working.

```
 subagents graph 01a18b81 1 running · 1 settled

 ╭─ main ─────────────────╮
 │ ~ waiting              │
 │ 2 calls                │
 ╰────────────┬───────────╯
              ●
              ├──●───●───●───●───●───●───●┐
              ▼                           ▼
 ╭─ alpha ────────────────╮  ╭─ beta ─────────────────╮
 │ + completed 14s        │  │ * running 30s          │
 │ 4 calls · 1 msg        │  │ > eval · 2 calls       │
 ╰────────────────────────╯  ╰────────────────────────╯

 ● active   ─ spawn   ─ task_send
```

**Board**:
The root pane in `tail` mode that lists every subagent with its status.

**Slot**:
A transcript pane that shows one worker at a time and passes to the next worker once its follower drains.
_Avoid_: split

**Follower**:
The process in a slot that prints one worker's transcript until the worker settles.
_Avoid_: tailer

**Drained**:
A follower that has printed every complete transcript record and exited, so its slot can pass to another worker.

**Launcher**:
What starts one streamer per pane for a session, from the agent's extension or by hand.
