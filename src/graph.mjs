// Graph mode: the whole session as one flow graph in a single pane.
//   createActivity(file) -> incremental reader of one transcript (tool calls, task_send messages, session id)
//   buildGraph(...)      -> { nodes: Map<id, Node>, edges: Edge[] }   main agent is node MAIN
//   render(graph, view)  -> one ANSI frame, exactly view.rows lines
// Spawn edges follow the task record's parent session; message edges come from task_send calls in transcripts.
import fs from "node:fs";

export const MAIN = "main";
const SEND = /(^|__)task_send$/;
const shortTool = (name) => String(name).split("__").pop();

// ---------- activity ----------
export function createActivity(file) {
  let offset = 0, rest = Buffer.alloc(0);
  const a = { file, sessionId: undefined, tools: 0, open: new Map(), sends: [] };
  a.poll = () => {
    let fd; try { fd = fs.openSync(file, "r"); } catch { return a; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return a;
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      rest = Buffer.concat([rest, buf]);
    } finally { fs.closeSync(fd); }
    const end = rest.lastIndexOf(0x0a); // keep a partial last line (and any split UTF-8 sequence) for the next poll
    if (end < 0) return a;
    for (const line of rest.subarray(0, end).toString("utf8").split("\n")) ingest(a, line);
    rest = rest.subarray(end + 1);
    return a;
  };
  return a;
}

function ingest(a, line) {
  let e; try { e = JSON.parse(line); } catch { return; }
  if (e.type === "session") { a.sessionId ??= e.id; return; }
  const m = e.message;
  if (e.type !== "message" || !m) return;
  if (m.role === "toolResult") { a.open.delete(m.toolCallId); return; }
  if (m.role !== "assistant" || !Array.isArray(m.content)) return;
  for (const c of m.content) {
    if (c.type !== "toolCall") continue;
    a.tools++;
    a.open.set(c.id, shortTool(c.name));
    if (SEND.test(c.name) && c.arguments?.to) a.sends.push({ to: String(c.arguments.to), at: Date.parse(e.timestamp) || Date.now() });
  }
}

// ---------- model ----------
// Node: { id, name, status, parent, started, ended, tools, tool, msgIn }
// Edge: { from, to, kind: "spawn" | "message", count, lastAt }
export function buildGraph({ session, tasks, acts, mainAlive = true }) {
  const stats = (id) => {
    const a = acts.get(id);
    return { tools: a?.tools ?? 0, tool: a ? [...a.open.values()].pop() : undefined };
  };
  const nodes = new Map([[MAIN, { id: MAIN, name: "main", status: mainAlive ? "running" : "exited", parent: null, msgIn: 0, ...stats(MAIN) }]]);
  const bySession = new Map([[session, MAIN]]);
  const byRef = new Map();
  for (const t of tasks) {
    const s = acts.get(t.id)?.sessionId;
    if (s) bySession.set(s, t.id);
    byRef.set(t.id, t.id);
  }
  for (const t of tasks) if (!byRef.has(t.name)) byRef.set(t.name, t.id);

  const edges = [];
  for (const t of tasks) {
    const parent = bySession.get(t.parent);
    const node = {
      id: t.id, name: t.name === t.id && t.description ? t.description : t.name, status: t.status,
      parent: parent && parent !== t.id ? parent : MAIN, started: t.started ?? t.created, ended: t.ended, msgIn: 0, ...stats(t.id),
    };
    nodes.set(t.id, node);
    edges.push({ from: node.parent, to: t.id, kind: "spawn", count: 1, lastAt: Date.parse(node.started) || 0 });
  }
  // a record whose parent chain loops never reaches MAIN: hang it off MAIN so layout terminates
  for (const n of nodes.values()) {
    const seen = new Set([n.id]);
    for (let p = n.parent; p && p !== MAIN; p = nodes.get(p)?.parent) {
      if (seen.has(p) || !nodes.has(p)) { n.parent = MAIN; break; }
      seen.add(p);
    }
  }
  for (const e of edges) if (e.kind === "spawn") e.from = nodes.get(e.to).parent;

  const msgs = new Map();
  for (const [from, a] of acts) {
    if (!nodes.has(from)) continue;
    for (const s of a.sends) {
      const to = byRef.get(s.to);
      if (!to || to === from) continue;
      if (nodes.get(to).parent === from) { nodes.get(to).msgIn++; continue; } // follow-up on its own spawn edge
      const key = `${from}>${to}`;
      const m = msgs.get(key) ?? { from, to, kind: "message", count: 0, lastAt: 0 };
      m.count++; m.lastAt = Math.max(m.lastAt, s.at);
      msgs.set(key, m);
    }
  }
  return { nodes, edges: [...edges, ...msgs.values()] };
}

// ---------- layout: tree on a slot grid, a parent above its middle child ----------
// Every card sits in a slot column, so the 2-column gutter between slots never holds a card: message edges run there.
const CARD_H = 4, GAP = 3, TOP = 2;

export function layout(graph, cols) {
  const kids = new Map([...graph.nodes.keys()].map((id) => [id, []]));
  for (const n of graph.nodes.values()) if (n.parent) kids.get(n.parent).push(n.id);
  const leaves = (id) => kids.get(id).reduce((s, k) => s + leaves(k), 0) || 1;
  const w = Math.max(14, Math.min(26, Math.floor(cols / leaves(MAIN)) - 2));
  const pos = new Map();
  let slot = 0;
  const place = (id, depth) => {
    const ks = kids.get(id);
    ks.forEach((k) => place(k, depth + 1));
    const s = ks.length ? pos.get(ks[(ks.length - 1) >> 1]).slot : slot++;
    const x = 1 + s * (w + 2);
    pos.set(id, { slot: s, x, y: TOP + depth * (CARD_H + GAP), w, cx: x + Math.floor(w / 2) });
  };
  place(MAIN, 0);
  return pos;
}

// ---------- render ----------
const U = 1, R = 2, D = 4, L = 8;
const LINE = [" ", "│", "─", "└", "│", "│", "┌", "├", "─", "┘", "─", "┴", "┐", "┤", "┬", "┼"];
const STATUS = { running: "33", started: "33", completed: "32", failed: "31", aborted: "31", cancelled: "31", killed: "31", lost: "31", exited: "2" };
const GLYPH = { running: "*", started: "*", completed: "+", exited: "-" };
const ACTIVE_MS = 10000;

function canvas(width, height) {
  const ch = Array.from({ length: height }, () => Array(width).fill(" "));
  const st = Array.from({ length: height }, () => Array(width).fill(""));
  const mask = Array.from({ length: height }, () => Array(width).fill(0));
  const inside = (x, y) => y >= 0 && y < height && x >= 0 && x < width;
  return {
    put(x, y, c, s = "") { if (inside(x, y)) { ch[y][x] = c; st[y][x] = s; } },
    text(x, y, str, s = "") { [...str].forEach((c, i) => this.put(x + i, y, c, s)); },
    link(x, y, bits, s) { if (inside(x, y)) { mask[y][x] |= bits; ch[y][x] = LINE[mask[y][x]]; st[y][x] = s; } },
    lines: () => ch.map((row, y) => {
      let out = "", cur = "";
      row.forEach((c, x) => { if (st[y][x] !== cur) { out += cur ? "\x1b[0m" : ""; cur = st[y][x]; out += cur ? `\x1b[${cur}m` : ""; } out += c; });
      return out + (cur ? "\x1b[0m" : "");
    }),
  };
}

// Expand a polyline into its ordered cells and draw it; stubs connect the first/last cell to the cards it joins.
function route(cv, pts, style, firstStub, lastStub) {
  const cells = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [[x0, y0], [x1, y1]] = [pts[i], pts[i + 1]];
    const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0);
    for (let x = x0, y = y0; ; x += dx, y += dy) {
      if (!cells.length || cells.at(-1)[0] !== x || cells.at(-1)[1] !== y) cells.push([x, y]);
      if (x === x1 && y === y1) break;
    }
  }
  const dir = ([ax, ay], [bx, by]) => (bx > ax ? R : bx < ax ? L : by > ay ? D : U);
  const flip = { [U]: D, [D]: U, [L]: R, [R]: L };
  cells.forEach((c, i) => {
    let bits = 0;
    if (i > 0) bits |= flip[dir(cells[i - 1], c)];
    if (i + 1 < cells.length) bits |= dir(c, cells[i + 1]);
    if (i === 0) bits |= firstStub;
    if (i === cells.length - 1) bits |= lastStub;
    cv.link(c[0], c[1], bits, style);
  });
  return cells;
}

const clipTo = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);
const secs = (n, now) => Math.max(0, Math.round(((Date.parse(n.ended ?? "") || now) - (Date.parse(n.started ?? "") || now)) / 1000));

function card(cv, n, p, now) {
  const color = n.id === MAIN ? "36" : STATUS[n.status] ?? "2";
  const inner = p.w - 2;
  const title = ` ${clipTo(n.name, inner - 3)} `;
  cv.text(p.x, p.y, "╭─" + title + "─".repeat(Math.max(0, inner - 1 - title.length)) + "╮", color);
  cv.text(p.x, p.y + 3, "╰" + "─".repeat(inner) + "╯", color);
  for (let y = 1; y <= 2; y++) { cv.put(p.x, p.y + y, "│", color); cv.put(p.x + p.w - 1, p.y + y, "│", color); cv.text(p.x + 1, p.y + y, " ".repeat(inner)); }
  const head = n.id === MAIN ? `${n.status}` : `${n.status} ${secs(n, now)}s`;
  cv.put(p.x + 2, p.y + 1, GLYPH[n.status] ?? "x", color);
  cv.text(p.x + 4, p.y + 1, clipTo(head, inner - 4));
  const calls = `${n.tools} call${n.tools === 1 ? "" : "s"}${n.msgIn ? ` · ${n.msgIn} msg` : ""}`;
  const busy = n.tool && n.status !== "completed" ? `> ${n.tool} · ` : "";
  cv.text(p.x + 2, p.y + 2, clipTo(busy + calls, inner - 2), "2");
}

// view: { cols, rows, frame, now, title }
export function render(graph, { cols = 100, rows = 30, frame = 0, now = Date.now(), title = "" } = {}) {
  const pos = layout(graph, cols);
  const span = [...pos.values()];
  const msgEdges = graph.edges.filter((e) => e.kind === "message");
  const bottom = Math.max(...span.map((p) => p.y + CARD_H));
  const width = Math.max(cols, ...span.map((p) => p.x + p.w + 1));
  const cv = canvas(width, Math.max(rows, bottom + msgEdges.length + 2));
  const beads = [], arrows = [];

  const spawns = graph.edges.filter((e) => e.kind === "spawn");
  const live = (e) => STATUS[graph.nodes.get(e.to).status] === "33";
  for (const e of [...spawns.filter((e) => !live(e)), ...spawns.filter(live)]) {
    const a = pos.get(e.from), b = pos.get(e.to), y = a.y + CARD_H;
    const cells = route(cv, [[a.cx, y], [a.cx, y + 1], [b.cx, y + 1], [b.cx, y + 2]], live(e) ? "33" : "2", U, 0);
    arrows.push([cells.at(-1), "▼", live(e) ? "33" : "2"]);
    if (live(e)) beads.push([cells, "1;33"]);
  }
  // out of the source's right side; straight into a neighbour on the same row, else down its gutter to a lane
  // below every card and up the target's left gutter
  msgEdges.forEach((e, k) => {
    const a = pos.get(e.from), b = pos.get(e.to), lane = bottom + k, sx = a.x + a.w, tx = b.x - 1;
    const beside = a.y === b.y && b.slot === a.slot + 1;
    const pts = beside ? [[sx, a.y + 2], [tx, b.y + 2]] : [[sx, a.y + 2], [sx, lane], [tx, lane], [tx, b.y + 2]];
    const cells = route(cv, pts, "35", L, 0);
    arrows.push([cells.at(-1), "▶", "35"], [[a.x + a.w - 1, a.y + 2], "├", "35"]);
    if (beside) { if (e.count > 1) cv.text(sx, a.y + 1, e.count > 9 ? "9+" : `×${e.count}`, "35"); }
    else cv.text(Math.max(sx, tx) + 2, lane, `${e.count} msg`, "35");
    if (now - e.lastAt < ACTIVE_MS) beads.push([cells, "1;35"]);
  });
  for (const [cells, style] of beads) cells.forEach(([x, y], i) => { if ((i - frame) % 4 === 0) cv.put(x, y, "●", style); });

  for (const n of graph.nodes.values()) card(cv, n, pos.get(n.id), now);
  for (const e of spawns) { const a = pos.get(e.from); cv.put(a.cx, a.y + CARD_H - 1, "┬", "2"); }
  for (const [[x, y], c, style] of arrows) cv.put(x, y, c, style);

  const subs = [...graph.nodes.values()].filter((n) => n.id !== MAIN);
  const running = subs.filter((n) => STATUS[n.status] === "33").length;
  cv.text(1, 0, `subagents graph ${title}`, "1");
  cv.text(2 + `subagents graph ${title}`.length, 0, `${running} running · ${subs.length - running} settled`, "2");
  const out = cv.lines().slice(0, rows - 1);
  out.push(`\x1b[2m ● active   ─ spawn   \x1b[35m─ task_send\x1b[0m`);
  return out.map((l) => cropAnsi(l, cols));
}

// Crop a line with SGR escapes to n visible columns.
function cropAnsi(line, n) {
  let out = "", seen = 0;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) { out += part; continue; }
    const chars = [...part];
    out += chars.slice(0, Math.max(0, n - seen)).join("");
    seen += chars.length;
  }
  return out + "\x1b[0m";
}
