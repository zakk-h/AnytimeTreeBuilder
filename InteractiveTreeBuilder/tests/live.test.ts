import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toDataset } from '../src/liveDataset';
import { NativeGraphAdapter, type NativeNodeView } from '../src/nativeGraph';
import { applySplit, autoExpandSingletons, makeRoot } from '../src/graphUtils';
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
test('CSV rejects malformed rows, quotes, missing values and non-numeric features', () => {
  for (const text of ['a,a\n1,2', 'a,b\n1,2,3', 'a,b\n1,"x', 'a,b\n1,"x"z']) assert.throws(() => parseCsv(text));
  for (const text of ['a,b\n,yes', 'a,b\nNaN,no', 'a,b\nhello,no', 'a,b\n1,']) assert.throws(() => toDataset(parseCsv(text), 'b'));
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
