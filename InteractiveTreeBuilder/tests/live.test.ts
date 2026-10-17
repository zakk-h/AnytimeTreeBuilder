import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toDataset } from '../src/liveDataset';
import { NativeGraphAdapter, type NativeNodeView } from '../src/nativeGraph';
import { applySplit, autoExpandSingletons, makeRoot } from '../src/graphUtils';
import { layoutTree } from '../src/layout';
import { fitLabelFont } from '../src/AdaptiveText';
import type { AndOrGraph } from '../src/types';
const graph: AndOrGraph = {
  root_trie_id: 0,
  trie_nodes: [{ id: 0, budget: 10, min_objective: 2, subproblem_size: 10, leaf_ids: [0], split_ids: [] }],
  leaf_nodes: [{ id: 0, parent_trie_id: 0, prediction: 0, loss: 2 }], split_nodes: [],
};
test('CSV handles RFC 4180, BOM, blank lines, CRLF and categorical labels', () => {
  const rows = parseCsv('\uFEFF"feature, one",target\r\n1,"a"\r\n2,"b"\r\n\r\n');
  assert.deepEqual(toDataset(rows, 'target'), { feature_names: ['feature, one'], class_names: ['a', 'b'], X: [[1], [2]], y: [0, 1] });
  assert.deepEqual(parseCsv('f,label\n1,"a""b\nc"\n')[1], ['1', 'a"b\nc']);
});
test('CSV rejects malformed rows, quotes, missing values and numeric overflow', () => {
  for (const text of ['a,a\n1,2', 'a,b\n1,2,3', 'a,b\n1,"x', 'a,b\n1,"x"z']) assert.throws(() => parseCsv(text));
  for (const text of ['a,b\n,yes', 'a,b\n1e309,no', 'a,b\n1,']) assert.throws(() => toDataset(parseCsv(text), 'b'));
});
test('CSV preserves numbers and handles case-insensitive boolean indicators', () => {
  const data = toDataset(parseCsv('score,MaxDelq2PublicRecLast12M_-9,mixed,label\n66,FALSE,1,yes\n59,TRUE,false,no\n-9, true ,TRUE,yes\n.5,False,0,no'), 'label');
  assert.deepEqual(data.feature_names, ['score', 'MaxDelq2PublicRecLast12M_-9', 'mixed']);
  assert.deepEqual(data.X, [[66, 0, 1], [59, 1, 0], [-9, 1, 1], [.5, 0, 0]]);
  assert.deepEqual(data.y, [0, 1, 0, 1]);
});
test('CSV encodes arbitrary text as deterministic named indicators without numeric ordering', () => {
  const rows = parseCsv('kind,mixed,label\n"a,b",10,no\n🍃,?,yes\n"<unknown>",10,no\n"a,b",NaN,yes');
  const data = toDataset(rows, 'label');
  assert.deepEqual(data.feature_names, ['kind = "<unknown>"', 'kind = "a,b"', 'kind = "🍃"', 'mixed = "10"', 'mixed = "?"', 'mixed = "NaN"']);
  assert.deepEqual(data.X, [[0, 1, 0, 1, 0, 0], [0, 0, 1, 0, 1, 0], [1, 0, 0, 1, 0, 0], [0, 1, 0, 0, 0, 1]]);
  const reversed = toDataset([rows[0], ...rows.slice(1).reverse()], 'label');
  assert.deepEqual(reversed.feature_names, data.feature_names);
  assert.deepEqual(reversed.X, [...data.X].reverse());
  assert.deepEqual(toDataset(parseCsv('kind,label\n"__proto__",no\n"constructor",yes'), 'label').X, [[1, 0], [0, 1]]);
});
test('generated category names cannot collide with original or other generated feature names', () => {
  const data = toDataset(parseCsv('color,"color = ""red""",label\nred,4,no\nblue,5,yes'), 'label');
  assert.deepEqual(data.feature_names, ['color = "blue"', 'color = "red" [2]', 'color = "red"']);
  assert.deepEqual(data.X, [[0, 1, 4], [1, 0, 5]]);
});
test('native view contains only one node options and immediate child summaries', () => {
  const adapter = new NativeGraphAdapter();
  const snapshot = makeRoot(graph);
  const response: NativeNodeView = {
    session_id: '1', checkpoint: 4, query_id: 1, root_budget: 10, root_minimum: 2, root_size: 10,
    summaries: [{ uid: 0, minimum: 2, sample_size: 10 }], visited_nodes: 1,
    options: { uid: 0, leaves: [], splits: [{ feature: 3, minimum: 2, left_minimum: 1, right_minimum: 1, left_size: 4, right_size: 6 }] },
  };
  const fragment = adapter.view(snapshot, response);
  assert.equal(fragment.trie_nodes.length, 3);
  assert.equal(fragment.split_nodes.length, 1);
  assert.equal(autoExpandSingletons(snapshot, fragment).root.kind, 'choice');
  const chosen = applySplit(snapshot, fragment, 0, fragment.split_nodes[0].id);
  assert.equal(chosen.root.kind, 'split');
  assert.equal(chosen.root.left?.kind, 'choice');
  const leftId = chosen.root.left!.graphTrieId;
  const next: NativeNodeView = { ...response, query_id: 2,
    summaries: [{ uid: 0, minimum: 2, sample_size: 10 }, { uid: 1, minimum: 1, sample_size: 4 }, { uid: 2, minimum: 1, sample_size: 6 }],
    options: { uid: 1, leaves: [{ prediction: 0, loss: 1 }], splits: [] }, visited_nodes: 3 };
  const nextFragment = adapter.view(chosen, next);
  assert.equal(nextFragment.trie_nodes.length, 3);
  assert.equal(nextFragment.trie_nodes.find(node => node.id === leftId)?.leaf_ids.length, 1);
  assert.equal(nextFragment.split_nodes.length, 1, 'Only the selected root split is retained');
  const normalized = adapter.normalize(chosen);
  assert.equal(normalized.root.left?.graphTrieId, leftId);
});

test('tree layout reserves the measured height of long wrapped feature names', () => {
  const tree = { uid: 0, graphTrieId: 0, kind: 'split' as const, left: { uid: 1, graphTrieId: 1, kind: 'choice' as const }, right: { uid: 2, graphTrieId: 2, kind: 'choice' as const } };
  const layout = layoutTree(tree, { '0': { width: 440, height: 600 }, '1': { width: 280, height: 130 }, '2': { width: 360, height: 300 } });
  const root = layout.nodes.find(n => n.uid === 0)!;
  for (const child of layout.nodes.filter(n => n.uid !== 0)) assert.ok(child.y >= root.y + 600 + 56);
  assert.ok(layout.nodes[2].x - (layout.nodes[1].x + 280) >= 32);
});

test('mixed card widths keep cousin subtrees apart and parents centered', () => {
  const leaf = (uid: number) => ({ uid, graphTrieId: uid, kind: 'leaf' as const });
  const tree = { uid: 0, graphTrieId: 0, kind: 'split' as const,
    left: { uid: 1, graphTrieId: 1, kind: 'split' as const, left: leaf(3), right: leaf(4) },
    right: { uid: 2, graphTrieId: 2, kind: 'split' as const, left: leaf(5), right: leaf(6) } };
  const sizes = Object.fromEntries([280, 440, 280, 440, 280, 440, 280].map((width, uid) => [uid, { width, height: 168 }]));
  const { nodes } = layoutTree(tree, sizes);
  const center = (uid: number) => nodes.find(n => n.uid === uid)!.x + sizes[uid].width / 2;
  for (const node of nodes) if (node.left && node.right) {
    assert.ok(Math.abs(center(node.uid) - (center(node.left.uid) + center(node.right.uid)) / 2) < .001);
  }
  for (const y of new Set(nodes.map(n => n.y))) {
    const row = nodes.filter(n => n.y === y).sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; ++i) assert.ok(row[i].x - row[i - 1].x - sizes[row[i - 1].uid].width >= 32);
  }
});

test('label fitting uses measured glyph widths and preserves a readable minimum', () => {
  const measure = (text: string, size: number) => Array.from(text).reduce((width, c) => width + (c === 'W' ? 1 : .3) * size, 0);
  assert.equal(fitLabelFont('hr ≤ 8.5', 300, measure, 28, 64), 64);
  assert.ok(fitLabelFont('WWWWWWWWWW', 240, measure, 28, 64) < fitLabelFont('iiiiiiiiii', 240, measure, 28, 64));
  assert.equal(fitLabelFont('W'.repeat(300), 240, measure, 28, 64), 28);
  assert.equal(fitLabelFont('a very long label with several words that cannot fit two lines', 100, measure, 28, 64), 28);
});
