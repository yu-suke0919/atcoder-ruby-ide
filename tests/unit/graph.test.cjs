const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/graph.mjs');
const at = (line, column, offset = 0) => ({ line, column, offset });
const edgesForm = (weighted = false, edges = at(0, 1)) => ({ kind: 'edges', line: 1, vertices: at(0, 0), edges, weighted });
const pairs = graph => graph.edges.map(({ from, to, weight }) => [graph.labels[from], graph.labels[to], weight]);

test('D4: edges are read by the form the input format gave, as many as the count says', async () => {
  const { readGraph } = await load();
  const graph = readGraph('4 3\r\n1 2\n2 3\n1 3\n2 4\n', edgesForm());
  assert.deepEqual(graph.labels, [1, 2, 3, 4]);
  // The fourth row is not an edge: the count says 3.
  assert.deepEqual(pairs(graph), [[1, 2, null], [2, 3, null], [1, 3, null]]);
  assert.equal(graph.root, null);
  const weighted = readGraph('3 2\n1 2 10\n2 3 1000000000000\n', edgesForm(true));
  assert.deepEqual(pairs(weighted), [[1, 2, '10'], [2, 3, '1000000000000']]);
  // A tree: connected with one edge fewer than the vertices. `N-1` comes as an offset.
  const tree = readGraph('3\n1 2\n1 3\n', edgesForm(false, at(0, 0, -1)));
  assert.equal(tree.root, 0);
  // Vertex 0 appears: vertices count from 0.
  const zero = readGraph('3 2\n0 1\n1 2\n', edgesForm());
  assert.deepEqual(zero.labels, [0, 1, 2]);
  assert.deepEqual(pairs(zero), [[0, 1, null], [1, 2, null]]);
  assert.equal(zero.root, 0);
});

test('D4: parents give a tree rooted at 1, with each parent pointing at its child', async () => {
  const { readGraph } = await load();
  const graph = readGraph('5\n1 1 2 2\n', { kind: 'parents', line: 1, vertices: at(0, 0) });
  assert.deepEqual(graph.labels, [1, 2, 3, 4, 5]);
  assert.deepEqual(pairs(graph), [[1, 2, null], [1, 3, null], [2, 4, null], [2, 5, null]]);
  assert.equal(graph.root, 0);
});

test('D4: a form chosen by hand reads from its line as long as the rows look like edges', async () => {
  const { readGraph } = await load();
  const edges = readGraph('5 3\n1 2 7\n2 3 8\n3 1 9\n2\n4 5\n', { kind: 'edges', line: 1 });
  assert.deepEqual(pairs(edges), [[1, 2, '7'], [2, 3, '8'], [3, 1, '9']]);
  assert.deepEqual(edges.labels, [1, 2, 3]);
  const parents = readGraph('x\n1 2 2\n', { kind: 'parents', line: 1 });
  assert.deepEqual(parents.labels, [1, 2, 3, 4]);
  assert.deepEqual(pairs(parents), [[1, 2, null], [2, 3, null], [2, 4, null]]);
  assert.match(readGraph('5 3\nabc\n', { kind: 'edges', line: 1 }).error, /2行目/);
});

test('D4: inputs that cannot be drawn say why', async () => {
  const { readGraph, MAX_VERTICES } = await load();
  assert.equal(MAX_VERTICES, 100);
  assert.match(readGraph('101 1\n1 2\n', edgesForm()).error, /101/);
  assert.match(readGraph('3 2\n1 2\n', edgesForm()).error, /3行目/);
  assert.match(readGraph('3 2\n1 2\n2 x\n', edgesForm()).error, /3行目/);
  assert.match(readGraph('3 1\n1 4\n', edgesForm()).error, /2行目/);
  assert.match(readGraph('N M\n1 2\n', edgesForm()).error, /1行目/);
  assert.match(readGraph('4\n1 1\n', { kind: 'parents', line: 1, vertices: at(0, 0) }).error, /2行目/);
});

test('D4: a tree is laid out from its root down, children in order and parents above them', async () => {
  const { readGraph, layoutGraph } = await load();
  const tree = readGraph('5\n1 3\n1 2\n2 4\n2 5\n', edgesForm(false, at(0, 0, -1)));
  const p = layoutGraph(tree);
  const [one, two, three, four, five] = p;
  assert.ok(one.y < two.y && two.y === three.y && two.y < four.y && four.y === five.y);
  assert.ok(two.x < three.x, 'children by number');
  assert.ok(four.x < five.x);
  assert.equal(two.x, (four.x + five.x) / 2);
});

test('D4: other graphs are spread out the same way every time', async () => {
  const { readGraph, layoutGraph } = await load();
  const graph = readGraph('6 6\n1 2\n2 3\n3 1\n4 5\n5 6\n6 4\n', edgesForm());
  const first = layoutGraph(graph);
  assert.deepEqual(layoutGraph(graph), first);
  for (const a of first) {
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
    for (const b of first) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 20, 'vertices apart');
  }
  // Connected vertices end up closer than the mean distance.
  const d = (i, j) => Math.hypot(first[i].x - first[j].x, first[i].y - first[j].y);
  assert.ok(d(0, 1) < d(0, 4));
  assert.deepEqual(layoutGraph(readGraph('1 0\n', edgesForm())), [{ x: 0, y: 0 }]);
});
