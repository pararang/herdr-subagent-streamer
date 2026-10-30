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

That is the `tail` stream mode. The `graph` mode puts the whole session in one pane instead: a flow graph with a card per agent, the main agent on top, spawn edges down to each subagent (nested ones under the subagent that spawned them), and `task_send` messages between subagents drawn as magenta `├─▶` edges. Edges animate while their agent is working. Inspired by [zoetrope](https://github.com/furkankly/zoetrope).

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

The default `hybrid` mode combines the two: the graph is the tab's first pane, and every subagent still gets its own live split next to it.

```
tab "1-subagents" (hybrid)
+-------------------+-------------------+
| graph             | scout   (live)    |
|                   +-------------------+
|                   | fixer   (live)    |
+-------------------+-------------------+
```

- Tab name: `<main agent's tab name>-subagents`, read at runtime.
- Closes itself 5 seconds after every subagent in it has finished. If the agent exits first, the tab stays until its subagents finish (omo) or closes right away (omp, whose subagents die with it).
- Outside herdr/tmux the plugin does nothing, so it is safe to install everywhere.

## Install

### Herdr marketplace

The [Herdr marketplace](https://herdr.dev/plugins/) discovers this repository through its `herdr-plugin` GitHub topic and root `herdr-plugin.toml`.

```bash
herdr plugin install pararang/herdr-subagent-streamer
```

This registers the package with Herdr. It does not install the agent extension. Complete the omo native or OMP installation below to enable streaming. The Herdr manifest declares metadata only, with no build commands, startup hooks, actions, or panes. The agent extension starts the streamer for each session.

To update the Herdr registration:

```bash
herdr plugin update pararang.subagent-streamer
```

### Agent extension

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

In `hybrid` and `tail` mode, for each new subagent the streamer splits the tab (alternating right and down) and runs a follower that pretty-prints the transcript until the subagent settles. The first pane is the graph in `hybrid` mode and the status board in `tail` mode. In `graph` mode the tab has only the graph pane (`streamer.mjs graph`), which reads every transcript incrementally: the task record's `parent_session_id` places each subagent under the agent that spawned it (omo; omp subagents all hang off the main agent), tool calls fill the cards, and `task_send` calls become message edges. A follow-up message to an agent's own child is counted on the child's card instead of getting a second edge. It drives the multiplexer with the `herdr` CLI (`tab create`, `pane split`, `pane run`, `tab close`) or `tmux` (`new-window`, `split-window`, `kill-window`).

## Configuration

`~/.config/herdr-subagent-streamer/config.json` (or under `$XDG_CONFIG_HOME`):

```json
{ "streamMode": "tail" }
```

| Key | Values | Default | Meaning |
|---|---|---|---|
| `streamMode` | `hybrid`, `tail`, `graph` | `hybrid` | `hybrid`: the graph pane plus one live split per subagent. `tail`: the status board plus one live split per subagent. `graph`: only the graph pane. An unknown value logs a warning and falls back to `hybrid`. |

The config is read when the streamer starts, so a change applies to the next agent session.

| Variable | Default | Meaning |
|---|---|---|
| `HERDR_SUBAGENT_STREAMER_STREAM_MODE` | config file, else `hybrid` | Overrides `streamMode`. An unknown value falls back to `hybrid`. |
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
- Large fan-outs make small transcript panes. The graph adapts to its own pane width and wraps whole subtrees onto additional rows. Resizing the pane reflows the cards. Extremely narrow panes shorten card text. Graphs taller than the pane are still cut off at the bottom, with no scrolling yet.
- It reads each host's on-disk layout and event payloads, which are not stable public APIs. If a host update breaks it, check `src/hosts.mjs` first.

## Tested

- omo native 5.1.33: installed with `omo install -l --approve`; a real session spawned two subagents, the tab opened with a board plus two live splits, and it closed itself after they finished.
- omp 18.10.4: installed with `omp plugin install`; the extension loads, `session_start` fires, a `task:subagent:lifecycle` event emitted on omp's event bus reaches the feed, and the tab opens and closes. tmux remains untested on either host.
- Live OMP session in herdr: four concurrent subagents streamed into separate panes, completed, and triggered automatic tab closure. The graph renderer showed all six fixture agents at 73 and 43 columns in a real herdr pane and reflowed after resizing. The streaming tab took focus when it opened, contrary to the intended no-focus behavior.

## Develop

```bash
npm test        # node --test; also passes under bun test
```

## License

MIT
