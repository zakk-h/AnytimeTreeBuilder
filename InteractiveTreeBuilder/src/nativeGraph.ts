import type { AndOrGraph, BuildNode, HistorySnapshot, LeafNode, SplitNode, TrieNode } from './types';

export type NativeSummary = { uid: number; minimum: number; sample_size: number; loss?: number };
export type NativeNodeView = {
  session_id: string; checkpoint: number; query_id: number;
  root_budget: number; root_minimum: number; root_size: number;
  summaries: NativeSummary[];
  options: { uid: number; leaves: Array<{ prediction: number; loss: number }>; splits: Array<{ feature: number; minimum: number; left_minimum: number; right_minimum: number; left_size: number; right_size: number }> };
  visited_nodes: number;
};
export type NativeConstraint = { mode: 'avoid' | 'sample'; forbiddenInternalFeatures?: number[]; featureTruth?: Record<string, boolean>; targetPrediction?: number };
export type NativeCompletion = { session_id: string; tree: BuildNode; active_uid: number; next_uid: number; visited_nodes: number; view: NativeNodeView };

/** An adapter for existing rendering functions, containing only the user's
 * displayed tree and ONE node's alternatives. It never accumulates visited DAGs.
 * IDs are local path labels, not exported native graph IDs. */
export class NativeGraphAdapter {
  private tries = new Map<string, number>();
  private splits = new Map<string, number>();
  private leaves = new Map<string, number>();
  private id(map: Map<string, number>, key: string) {
    if (!map.has(key)) map.set(key, map.size);
    return map.get(key)!;
  }
  private child(path: string, feature: number, side: 'L' | 'R') { return `${path}/${feature}${side}`; }
  normalize(snapshot: HistorySnapshot): HistorySnapshot {
    const next = structuredClone(snapshot);
    const visit = (node: BuildNode, path: string) => {
      node.graphTrieId = this.id(this.tries, path);
      if (node.kind === 'split') {
        node.splitId = this.id(this.splits, `${path}/${node.feature}`);
        if (!node.left || !node.right || node.feature === undefined) throw new Error('Native completion returned an incomplete split.');
        visit(node.left, this.child(path, node.feature, 'L'));
        visit(node.right, this.child(path, node.feature, 'R'));
      } else if (node.kind === 'leaf') node.leafId = this.id(this.leaves, `${path}/${node.prediction}`);
    };
    visit(next.root, '');
    return next;
  }
  view(snapshot: HistorySnapshot, response: NativeNodeView): AndOrGraph {
    const summaries = new Map(response.summaries.map(s => [s.uid, s]));
    const tries = new Map<number, TrieNode>(), splits = new Map<number, SplitNode>(), leaves = new Map<number, LeafNode>();
    const trie = (path: string, minimum: number, size: number) => {
      const id = this.id(this.tries, path);
      if (!tries.has(id)) tries.set(id, { id, budget: response.root_budget, min_objective: minimum, subproblem_size: size, leaf_ids: [], split_ids: [] });
      return tries.get(id)!;
    };
    const addLeaf = (path: string, prediction: number, loss: number, size: number) => {
      const parent = this.id(this.tries, path), id = this.id(this.leaves, `${path}/${prediction}`);
      leaves.set(id, { id, parent_trie_id: parent, prediction, loss, subproblem_size: size });
      const node = tries.get(parent)!; if (!node.leaf_ids.includes(id)) node.leaf_ids.push(id);
    };
    const addSplit = (path: string, feature: number, minimum: number) => {
      const parent = this.id(this.tries, path), id = this.id(this.splits, `${path}/${feature}`);
      splits.set(id, { id, parent_trie_id: parent, feature, min_objective: minimum, left_trie_id: this.id(this.tries, this.child(path, feature, 'L')), right_trie_id: this.id(this.tries, this.child(path, feature, 'R')) });
      const node = tries.get(parent)!; if (!node.split_ids.includes(id)) node.split_ids.push(id);
    };
    const visit = (node: BuildNode, path: string) => {
      const summary = summaries.get(node.uid);
      if (!summary) throw new Error('Native query omitted a displayed node.');
      trie(path, summary.minimum, summary.sample_size);
      if (node.kind === 'leaf') addLeaf(path, node.prediction!, summary.loss!, summary.sample_size);
      if (node.kind === 'split') {
        visit(node.left!, this.child(path, node.feature!, 'L'));
        visit(node.right!, this.child(path, node.feature!, 'R'));
        addSplit(path, node.feature!, summaries.get(node.left!.uid)!.minimum + summaries.get(node.right!.uid)!.minimum);
      }
      if (node.uid === response.options.uid && node.kind === 'choice') {
        for (const leaf of response.options.leaves) addLeaf(path, leaf.prediction, leaf.loss, summary.sample_size);
        for (const split of response.options.splits) {
          trie(this.child(path, split.feature, 'L'), split.left_minimum, split.left_size);
          trie(this.child(path, split.feature, 'R'), split.right_minimum, split.right_size);
          addSplit(path, split.feature, split.minimum);
        }
      }
    };
    visit(snapshot.root, '');
    return { root_trie_id: this.id(this.tries, ''), trie_nodes: [...tries.values()], split_nodes: [...splits.values()], leaf_nodes: [...leaves.values()], metadata: { native: true, session_id: response.session_id, query_id: response.query_id, active_uid: response.options.uid } };
  }
}

export async function nativeApi<T>(path: string, session: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}?session_id=${encodeURIComponent(session)}`, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? 'Native graph query failed.');
  return payload;
}

declare global {
  interface Window {
    ARBORENUM_NATIVE_CONSTRAINED_COMPLETION?: (spec: NativeConstraint) => Promise<{ ok: boolean; message: string }>;
  }
}
