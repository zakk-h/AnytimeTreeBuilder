import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGraph, completeGraph } from '../src/graphAnalysis';
import { parseCsv, toDataset } from '../src/liveDataset';
import type { AndOrGraph, BuildNode } from '../src/types';
const softplus = (s: number) => Math.max(0, s) + Math.log1p(Math.exp(-Math.abs(s)));
test('logistic analysis preserves corrections and recipient offsets across all replacements', () => {
    const data = { feature_names: ['x'], class_names: ['0', '1'], X: [[0], [0], [1], [1]], y: [0, 1, 0, 1], base_logits: [-2, .5, 1, -.7] };
    const loss = (rows: number[], c: number) => rows.reduce((sum, i) => sum + softplus((1 - 2 * data.y[i]) * (data.base_logits[i] + c)), 0);
    const graph: AndOrGraph = { root_trie_id: 0, trie_nodes: [
        { id: 0, budget: 20, subproblem_size: 4, leaf_ids: [0], split_ids: [0] },
        { id: 1, budget: 20, subproblem_size: 2, leaf_ids: [1], split_ids: [] },
        { id: 2, budget: 20, subproblem_size: 2, leaf_ids: [2], split_ids: [] }],
        split_nodes: [{ id: 0, parent_trie_id: 0, feature: 0, left_trie_id: 1, right_trie_id: 2 }],
        leaf_nodes: [{ id: 0, parent_trie_id: 0, prediction: -1, loss: .1 + loss([0,1,2,3], -1), subproblem_size: 4 },
        { id: 1, parent_trie_id: 1, prediction: .4, loss: .1 + loss([0,1], .4), subproblem_size: 2 },
        { id: 2, parent_trie_id: 2, prediction: -.8, loss: .1 + loss([2,3], -.8), subproblem_size: 2 }] };
    const meta = { task: 'logistic', gamma: .1, root_n: 4, featureRegistry: [{ internalFeature: 0, originalFeature: 0, originalName: 'x', threshold: .5 }] };
    const tree: BuildNode = { uid: 0, kind: 'choice', graphTrieId: 0 };
    const result = analyzeGraph(graph, meta, tree, data);
    const expected = [() => -1, (x: number) => x <= .5 ? .4 : -.8].map(predict => {
        let baseline = 0, changed = 0;
        for (let i = 0; i < 4; ++i) {
            baseline += softplus((1 - 2 * data.y[i]) * (data.base_logits[i] + predict(data.X[i][0]))) / 4;
            for (let j = 0; j < 4; ++j) changed += softplus((1 - 2 * data.y[i]) * (data.base_logits[i] + predict(data.X[j][0]))) / 16;
        }
        return { baseline, delta: changed - baseline, ratio: changed / baseline };
    });
    assert.equal(result.task, 'logistic'); assert.equal(result.tree_count, '2'); assert.equal(result.disagreement.length, 0); assert.equal(result.abstention_enabled, false);
    assert.ok(Math.abs(result.log_loss!.min - Math.min(...expected.map(v => v.baseline))) < 1e-12);
    assert.ok(Math.abs(result.importance[0].min - Math.min(...expected.map(v => v.delta))) < 1e-12);
    assert.ok(Math.abs(result.importance[0].max - Math.max(...expected.map(v => v.delta))) < 1e-12);
    assert.ok(Math.abs(result.importance[0].min_ratio! - Math.min(...expected.map(v => v.ratio))) < 1e-12);
    assert.ok(Math.abs(result.importance[0].max_ratio! - Math.max(...expected.map(v => v.ratio))) < 1e-12);
    const complete = completeGraph(graph, meta, tree, 1);
    assert.equal(analyzeGraph(graph, meta, complete.tree, data).tree_count, '1');
    assert.throws(() => analyzeGraph(graph, meta, tree, { ...data, base_logits: [0] }));
    assert.throws(() => analyzeGraph(graph, meta, tree, { ...data, base_logits: [0,0,0,0] }));
});
test('logistic CSV parsing excludes offsets from features and requires binary labels', () => {
    const data = toDataset(parseCsv('x,z,y\n0,-1,0\n1,2,1'), 'y', 'logistic', 'z');
    assert.deepEqual(data.X, [[0], [1]]); assert.deepEqual(data.y, [0,1]); assert.deepEqual(data.base_logits, [-1,2]);
    assert.deepEqual(data.class_names, ['0', '1']);
    assert.throws(() => toDataset(parseCsv('x,y\n0,2'), 'y', 'logistic'));
    assert.throws(() => toDataset(parseCsv('x,z,y\n0,,0'), 'y', 'logistic', 'z'));
});

test('logistic live settings retain optimizer controls and reject unsupported abstention', async () => {
    const { DEFAULT_TRAINING_SETTINGS, nativeTrainingSettings, trainingSettingsError } = await import('../src/trainingSettings');
    const settings = { ...DEFAULT_TRAINING_SETTINGS, task: 'logistic', base_logit_column: 'z' };
    assert.equal(trainingSettingsError(settings), undefined);
    const native = nativeTrainingSettings(settings);
    assert.equal(native.greedy_continuous_mode, 'numerical'); assert.equal(native.leaf_logit_clip, 30);
    assert.equal('base_logit_column' in native, false);
    assert.ok(trainingSettingsError({ ...settings, allow_abstain: true }));
    assert.ok(trainingSettingsError({ ...settings, leaf_logit_clip: 0 }));
});
