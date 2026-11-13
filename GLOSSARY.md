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

**Stream mode**:
Which panes the subagents tab holds: `hybrid` (graph and transcript panes), `tail` (board and transcript panes) or `graph` (graph only).

**Graph**:
The root pane that draws the agent and its subagents as cards joined by spawn and message edges.

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
