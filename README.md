# herdr-subagent-streamer

Watch your coding agent's subagents work live. Install once, start the agent inside herdr (or tmux), and every subagent gets its own split in one extra tab, streaming its prompt, thinking, tool calls and result as they happen.

Works with **omo native** and **omp** (oh-my-pi). Nothing to start by hand.

> **Warning:** only tested with herdr. tmux support is implemented but has not been tested yet, so expect rough edges there.

```
tab "1"               tab "1-subagents"
+-----------------+   +-------------------+-------------------+
| main agent      |   | board (status)    | scout   (live)    |
|                 |   |                   +-------------------+
|                 |   |                   | fixer   (live)    |
+-----------------+   +-------------------+-------------------+
```

- Tab name: `<main agent's tab name>-subagents`, read at runtime.
- Closes itself 5 seconds after every subagent in it has finished. If the agent exits first, the tab stays until its subagents finish (omo) or closes right away (omp, whose subagents die with it).
- Outside herdr/tmux the plugin does nothing, so it is safe to install everywhere.

## Install

omo native:

```bash
omo install git:github.com/pararang/herdr-subagent-streamer
# or from a checkout (git clone https://github.com/pararang/herdr-subagent-streamer):
omo install ./herdr-subagent-streamer
```

`omo install -l` (project-local) works too, but omo only loads project-local packages after you approve them: start with `omo --approve`.

omp:

```bash
omp plugin install ./herdr-subagent-streamer   # from a checkout of the repo above
# or load the extension for one run:
omp -e ./herdr-subagent-streamer/extension/index.js
```

Requirements: herdr (`herdr` on PATH) or tmux, plus `bun` or `node` >= 18 on PATH. No npm dependencies.

## Use

Start the agent in a herdr pane and spawn subagents as usual. The first subagent opens the `-subagents` tab without taking focus.

## How it works

The extension (`extension/index.js`) runs when a session starts and launches `src/streamer.mjs` as a detached process for that session, then stops it on shutdown. The streamer finds subagents through a host adapter (`src/hosts.mjs`):

| Host | Where subagent state comes from |
|---|---|
| omo native | Polls `$OMO_CODING_AGENT_DIR/projects/*/senpi-task/tasks/*.json` (default `~/.omo/agent`) and tails each child's transcript under `children/<id>/sessions/<id>/`. |
| omp | The extension forwards the `task:subagent:lifecycle` event (`id`, `status`, `sessionFile`) to a feed file in the temp dir; the transcript is the event's `sessionFile`, or `<session file minus .jsonl>/<id>.jsonl`. |

For each new subagent the streamer splits the tab (alternating right and down) and runs a follower that pretty-prints the transcript until the subagent settles. It drives the multiplexer with the `herdr` CLI (`tab create`, `pane split`, `pane run`, `tab close`) or `tmux` (`new-window`, `split-window`, `kill-window`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HERDR_SUBAGENT_STREAMER_CLOSE_MS` | `5000` | Close the tab this long after all subagents settle. `0` keeps it open. |
| `HERDR_SUBAGENT_STREAMER_HOST` | `omo` when `OMO_NATIVE=1`, else `omp` | Force the host adapter. |
| `HERDR_SUBAGENT_STREAMER_MUX` | `herdr` when `HERDR_ENV=1`, else `tmux` when `$TMUX` is set | Force the multiplexer. |

The streamer's log is `<tmpdir>/herdr-subagent-streamer/<pane>.log`.

## Limits

- omo is polled about once a second. A subagent that finishes faster still gets a split, after it is done, with the full transcript replayed.
- omp: only detached (background) spawns emit a `started` event; a blocking spawn appears once it has finished.
- omo only: a detached subagent whose parent already exited keeps `status: running` in omo's record. The streamer treats a transcript that ends in a plain assistant reply and has been quiet for 3 seconds as finished.
- Subagents that already finished when the session starts get no split.
- The splits are transcript tails, not herdr agents: no working/idle badge and no typing into them.
- Large fan-outs make small panes.
- It reads each host's on-disk layout and event payloads, which are not stable public APIs. If a host update breaks it, check `src/hosts.mjs` first.

## Tested

- omo native 5.1.33: installed with `omo install -l --approve`; a real session spawned two subagents, the tab opened with a board plus two live splits, and it closed itself after they finished.
- omp 18.10.4: installed with `omp plugin install`; the extension loads, `session_start` fires, a `task:subagent:lifecycle` event emitted on omp's event bus reaches the feed, and the tab opens and closes. Not tested: omp spawning real subagents (needs a configured model), and tmux on either host.

## Develop

```bash
npm test        # node --test; also passes under bun test
```

## License

MIT
