// The graph of a sample input (D4): read by the form the task's input format gave, or by one
// chosen by hand, and laid out for drawing. Nothing here touches the page.
export const MAX_VERTICES = 100;

const INTEGER = /^-?\d+$/;

// A graph: vertex labels, edges between their indices (weights as written) and, for a tree,
// the index of its root.
function graphOf(n, rows, base) {
  const labels = Array.from({ length: n }, (_, i) => i + base);
  for (const { number, ends } of rows) {
    if (ends.some(v => v < base || v >= base + n)) return { error: `${number}行目の頂点の番号が範囲外です（${base}〜${base + n - 1}）。` };
  }
  const edges = rows.map(({ ends: [from, to], weight }) => ({ from: from - base, to: to - base, weight }));
  return { labels, edges, root: isTree(n, edges) ? 0 : null };
}

// Connected with one edge fewer than its vertices.
function isTree(n, edges) {
  if (edges.length !== n - 1) return false;
  const seen = new Set([0]);
  const next = [0];
  const around = neighbors(n, edges);
  while (next.length) for (const v of around[next.pop()]) if (!seen.has(v)) { seen.add(v); next.push(v); }
  return seen.size === n;
}

function neighbors(n, edges) {
  const around = Array.from({ length: n }, () => []);
  for (const { from, to } of edges) { around[from].push(to); around[to].push(from); }
  return around.map(list => [...new Set(list)].sort((a, b) => a - b));
}

// Reads the graph from a sample input. A form from the input format says where the counts are;
// one chosen by hand has only its kind and line, and reads as far as the rows look right.
export function readGraph(input, form) {
  const lines = input.replace(/\r/g, '').split('\n').map(line => line.trim().split(/\s+/).filter(Boolean));
  const unread = line => ({ error: `${line + 1}行目を読めません。` });
  const value = at => {
    const token = lines[at.line]?.[at.column];
    return INTEGER.test(token ?? '') ? Number(token) + at.offset : null;
  };
  const tooMany = n => (n > MAX_VERTICES ? { error: `頂点が${n}個あります。${MAX_VERTICES}個までを描きます。` } : null);
  let n = form.vertices ? value(form.vertices) : null;
  if (form.vertices && n === null) return unread(form.vertices.line);
  if (n !== null && n < 1) return { error: '頂点がありません。' };
  if (n !== null && tooMany(n)) return tooMany(n);
  const rows = [];
  if (form.kind === 'parents') {
    const row = lines[form.line] ?? [];
    const count = n === null ? row.length : n - 1;
    if (row.length !== count || !row.every(token => INTEGER.test(token)) || (n === null && !row.length)) return unread(form.line);
    n ??= count + 1;
    if (tooMany(n)) return tooMany(n);
    row.forEach((token, i) => rows.push({ number: form.line + 1, ends: [Number(token), i + 2], weight: null }));
    return graphOf(n, rows, 1);
  }
  const width = form.vertices ? (form.weighted ? 3 : 2) : lines[form.line]?.length;
  const count = form.vertices ? value(form.edges) : Infinity;
  if (count === null) return unread(form.edges.line);
  for (let line = form.line; rows.length < count; line++) {
    const row = lines[line];
    const fits = row && (width === 2 || width === 3) && row.length === width && INTEGER.test(row[0]) && INTEGER.test(row[1]);
    if (!fits) {
      if (form.vertices || !rows.length) return unread(line);
      break;
    }
    rows.push({ number: line + 1, ends: [Number(row[0]), Number(row[1])], weight: row[2] ?? null });
  }
  const base = rows.some(({ ends }) => ends.includes(0)) ? 0 : 1;
  n ??= Math.max(0, ...rows.flatMap(({ ends }) => ends)) + 1 - base;
  return tooMany(n) ?? graphOf(n, rows, base);
}

const LEVEL = 80;
const SLOT = 56;
const SPRING = 80;

// Positions to draw the vertices at: a tree from its root down, other graphs spread out by
// springs on the edges and pushing between vertices, from a circle, so always the same.
export function layoutGraph(graph) {
  const n = graph.labels.length;
  if (graph.root !== null) return layoutTree(graph, n);
  const radius = Math.max(SPRING, (n * SPRING) / (2 * Math.PI));
  const p = Array.from({ length: n }, (_, i) => n === 1 ? { x: 0, y: 0 } : {
    x: radius * Math.sin((2 * Math.PI * i) / n),
    y: -radius * Math.cos((2 * Math.PI * i) / n)
  });
  const rounds = 300;
  for (let round = 0; round < rounds; round++) {
    const move = p.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = p[i].x - p[j].x || 0.01 * (i - j);
        const dy = p[i].y - p[j].y;
        const d = Math.max(Math.hypot(dx, dy), 0.01);
        const push = (SPRING * SPRING) / d;
        move[i].x += (dx / d) * push; move[i].y += (dy / d) * push;
        move[j].x -= (dx / d) * push; move[j].y -= (dy / d) * push;
      }
    }
    for (const { from, to } of graph.edges) {
      if (from === to) continue;
      const dx = p[from].x - p[to].x;
      const dy = p[from].y - p[to].y;
      const d = Math.max(Math.hypot(dx, dy), 0.01);
      const pull = (d * d) / SPRING;
      move[from].x -= (dx / d) * pull; move[from].y -= (dy / d) * pull;
      move[to].x += (dx / d) * pull; move[to].y += (dy / d) * pull;
    }
    // A pull toward the middle keeps separate parts near each other.
    const limit = radius * 0.2 * (1 - round / rounds) + 1;
    p.forEach((at, i) => {
      move[i].x -= at.x * 0.2 * Math.hypot(at.x, at.y) / SPRING;
      move[i].y -= at.y * 0.2 * Math.hypot(at.x, at.y) / SPRING;
      const d = Math.hypot(move[i].x, move[i].y);
      const step = d > limit ? limit / d : 1;
      at.x += move[i].x * step;
      at.y += move[i].y * step;
    });
  }
  return p.map(({ x, y }) => ({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }));
}

// Leaves take the next slot from the left; a parent sits midway over its first and last child.
function layoutTree(graph, n) {
  const around = neighbors(n, graph.edges);
  const p = Array.from({ length: n }, () => ({ x: 0, y: 0 }));
  const seen = new Set();
  let slot = 0;
  const place = (v, depth) => {
    seen.add(v);
    const children = around[v].filter(c => !seen.has(c));
    children.forEach(c => seen.add(c));
    p[v].y = depth * LEVEL;
    if (!children.length) { p[v].x = slot++ * SLOT; return; }
    for (const c of children) place(c, depth + 1);
    p[v].x = (p[children[0]].x + p[children.at(-1)].x) / 2;
  };
  place(graph.root, 0);
  return p;
}
