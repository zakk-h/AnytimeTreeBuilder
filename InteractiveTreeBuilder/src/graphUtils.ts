import type { AndOrGraph, BuildNode, Choice, ChoiceBudget, FeatureMeta, HistorySnapshot, NodeBudget } from './types';

type GraphIndex = {
  trie: Map<number, AndOrGraph['trie_nodes'][number]>;
  splits: Map<number, AndOrGraph['split_nodes'][number]>;
  leaves: Map<number, AndOrGraph['leaf_nodes'][number]>;
};

type CompletionPlan =
  | { kind: 'leaf'; leafId: number; objective: number }
  | {
      kind: 'split';
      splitId: number;
      objective: number;
      left: CompletionPlan;
      right: CompletionPlan;
    };

type ConstrainedCompletionSpec =
  | {
      mode: 'avoid';
      forbiddenInternalFeatures: number[];
    }
  | {
      mode: 'sample';
      featureTruth: Record<string, boolean>;
      targetPrediction: number;
    };

declare global {
  interface Window {
    ARBORENUM_CONSTRAINED_COMPLETION?: ConstrainedCompletionSpec;
    ARBORENUM_CONSTRAINED_COMPLETION_RESULT?: {
      ok: boolean;
      message: string;
    };
  }
}

const indexCache = new WeakMap<AndOrGraph, GraphIndex>();

function buildIndexUncached(graph: AndOrGraph): GraphIndex {
  return {
    trie: new Map(graph.trie_nodes.map((x) => [x.id, x])),
    splits: new Map(graph.split_nodes.map((x) => [x.id, x])),
    leaves: new Map(graph.leaf_nodes.map((x) => [x.id, x]))
  };
}

export function buildIndex(graph: AndOrGraph): GraphIndex {
  const cached = indexCache.get(graph);
  if (cached) return cached;

  const idx = buildIndexUncached(graph);
  indexCache.set(graph, idx);
  return idx;
}

export function cloneTree<T>(x: T): T {
  return structuredClone(x);
}

export function makeRoot(graph: AndOrGraph): HistorySnapshot {
  return {
    root: { uid: 0, graphTrieId: graph.root_trie_id, kind: 'choice' },
    activeUid: 0,
    nextUid: 1
  };
}

export function walk(root: BuildNode): BuildNode[] {
  const out: BuildNode[] = [];
  const dfs = (n?: BuildNode) => {
    if (!n) return;
    out.push(n);
    dfs(n.left);
    dfs(n.right);
  };
  dfs(root);
  return out;
}

export function findNode(root: BuildNode, uid: number): BuildNode | undefined {
  return walk(root).find((n) => n.uid === uid);
}

export function unresolvedNodes(root: BuildNode): BuildNode[] {
  return walk(root).filter((n) => n.kind === 'choice');
}

export function choicesFor(graph: AndOrGraph, graphTrieId: number): Choice[] {
  const idx = buildIndex(graph);
  const t = idx.trie.get(graphTrieId);
  if (!t) return [];
  const leaves: Choice[] = t.leaf_ids
    .map((id) => idx.leaves.get(id))
    .filter(Boolean)
    .map((leaf) => ({ kind: 'leaf', leaf: leaf! }));
  const splits: Choice[] = t.split_ids
    .map((id) => idx.splits.get(id))
    .filter(Boolean)
    .map((split) => ({ kind: 'split', split: split! }));
  return [...leaves, ...splits];
}

export function rootTrie(graph: AndOrGraph) {
  return buildIndex(graph).trie.get(graph.root_trie_id);
}

export function rootBudget(graph: AndOrGraph): number {
  const b = Number(rootTrie(graph)?.budget);
  return Number.isFinite(b) ? b : Number.POSITIVE_INFINITY;
}

export function rootSize(graph: AndOrGraph): number {
  const n = Number(rootTrie(graph)?.subproblem_size);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function fallbackMin(graph: AndOrGraph, trieId: number): number {
  const choices = choicesFor(graph, trieId);
  if (choices.length === 0) return 0;
  return Math.min(...choices.map((c) => choiceObjective(graph, c)));
}

export function trieMinObjective(graph: AndOrGraph, graphTrieId: number): number {
  const t = buildIndex(graph).trie.get(graphTrieId);
  const x = Number(t?.min_objective);
  return Number.isFinite(x) ? x : fallbackMin(graph, graphTrieId);
}

export function leafObjective(leaf: { loss?: number; objective?: number }): number {
  const loss = Number(leaf.loss);
  if (Number.isFinite(loss)) return loss;
  const objective = Number(leaf.objective);
  return Number.isFinite(objective) ? objective : Number.POSITIVE_INFINITY;
}

export function splitObjective(graph: AndOrGraph, split: { min_objective?: number; objective?: number; left_trie_id: number; right_trie_id: number }): number {
  const minObj = Number(split.min_objective);
  if (Number.isFinite(minObj)) return minObj;
  const objective = Number(split.objective);
  if (Number.isFinite(objective)) return objective;
  return trieMinObjective(graph, split.left_trie_id) + trieMinObjective(graph, split.right_trie_id);
}

export function choiceObjective(graph: AndOrGraph, choice: Choice): number {
  return choice.kind === 'leaf' ? leafObjective(choice.leaf) : splitObjective(graph, choice.split);
}

export function lowerBound(graph: AndOrGraph, node?: BuildNode): number {
  if (!node) return 0;
  const idx = buildIndex(graph);

  if (node.kind === 'choice') {
    return trieMinObjective(graph, node.graphTrieId);
  }

  if (node.kind === 'leaf') {
    const leaf = node.leafId == null ? undefined : idx.leaves.get(node.leafId);
    return leaf ? leafObjective(leaf) : Number.POSITIVE_INFINITY;
  }

  return lowerBound(graph, node.left) + lowerBound(graph, node.right);
}

export function nodeBudgetFor(graph: AndOrGraph, snapshot: HistorySnapshot, uid: number): NodeBudget | undefined {
  const node = findNode(snapshot.root, uid);
  if (!node || node.kind !== 'choice') return undefined;

  const rootBound = rootBudget(graph);
  const totalLower = lowerBound(graph, snapshot.root);
  const nodeBest = trieMinObjective(graph, node.graphTrieId);
  const otherLower = totalLower - nodeBest;
  const available = rootBound - otherLower;

  return {
    rootBudget: rootBound,
    rootSize: rootSize(graph),
    currentLowerBound: totalLower,
    otherLowerBound: otherLower,
    nodeBestObjective: nodeBest,
    nodeAvailableBudget: available,
    globalSlack: rootBound - totalLower
  };
}

export function annotateChoicesFor(graph: AndOrGraph, snapshot: HistorySnapshot, uid: number): ChoiceBudget[] {
  const node = findNode(snapshot.root, uid);
  if (!node || node.kind !== 'choice') return [];
  const budget = nodeBudgetFor(graph, snapshot, uid);
  const available = budget?.nodeAvailableBudget ?? Number.POSITIVE_INFINITY;

  return choicesFor(graph, node.graphTrieId).map((choice) => {
    const objective = choiceObjective(graph, choice);
    const excess = objective - available;
    return {
      choice,
      objective,
      feasible: objective <= available + 1e-9,
      excess: Math.max(0, excess)
    };
  });
}

export function normalizedObjective(graph: AndOrGraph, value: number): number {
  return value / rootSize(graph);
}

export function formatObjective(graph: AndOrGraph, value: number): string {
  if (!Number.isFinite(value)) return '∞';
  return normalizedObjective(graph, value).toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export function applySplit(
  snapshot: HistorySnapshot,
  graph: AndOrGraph,
  uid: number,
  splitId: number,
  autoExpandWithinUid?: number,
): HistorySnapshot {
  const feasible = annotateChoicesFor(graph, snapshot, uid).some(
    (x) => x.feasible && x.choice.kind === 'split' && x.choice.split.id === splitId
  );
  if (!feasible) return snapshot;

  const next = cloneTree(snapshot);
  const idx = buildIndex(graph);
  const node = findNode(next.root, uid);
  const split = idx.splits.get(splitId);
  if (!node || !split || node.kind !== 'choice') return snapshot;

  const left: BuildNode = { uid: next.nextUid++, graphTrieId: split.left_trie_id, kind: 'choice' };
  const right: BuildNode = { uid: next.nextUid++, graphTrieId: split.right_trie_id, kind: 'choice' };

  node.kind = 'split';
  node.feature = split.feature;
  node.splitId = split.id;
  node.prediction = undefined;
  node.left = left;
  node.right = right;
  next.activeUid = left.uid;

  return autoExpandSingletons(next, graph, autoExpandWithinUid);
}

export function applyLeaf(
  snapshot: HistorySnapshot,
  graph: AndOrGraph,
  uid: number,
  leafId: number,
  autoExpandWithinUid?: number,
): HistorySnapshot {
  const feasible = annotateChoicesFor(graph, snapshot, uid).some(
    (x) => x.feasible && x.choice.kind === 'leaf' && x.choice.leaf.id === leafId
  );
  if (!feasible) return snapshot;

  const next = cloneTree(snapshot);
  const idx = buildIndex(graph);
  const node = findNode(next.root, uid);
  const leaf = idx.leaves.get(leafId);
  if (!node || !leaf || node.kind !== 'choice') return snapshot;

  node.kind = 'leaf';
  node.prediction = leaf.prediction;
  node.leafId = leaf.id;
  node.feature = undefined;
  node.left = undefined;
  node.right = undefined;

  const unresolved = unresolvedNodes(next.root);
  next.activeUid = unresolved[0]?.uid ?? node.uid;

  return autoExpandSingletons(next, graph, autoExpandWithinUid);
}

export function rewind(snapshot: HistorySnapshot, uid: number): HistorySnapshot {
  const next = cloneTree(snapshot);
  const node = findNode(next.root, uid);
  if (!node) return snapshot;
  node.kind = 'choice';
  node.feature = undefined;
  node.prediction = undefined;
  node.splitId = undefined;
  node.leafId = undefined;
  node.left = undefined;
  node.right = undefined;
  next.activeUid = uid;
  next.nextUid = Math.max(...walk(next.root).map((n) => n.uid)) + 1;
  return next;
}

export function autoExpandSingletons(
  snapshot: HistorySnapshot,
  graph: AndOrGraph,
  withinUid?: number,
): HistorySnapshot {
  if (graph.metadata?.native) return snapshot;
  let cur = snapshot;

  while (true) {
    const scopeRoot = withinUid === undefined ? cur.root : findNode(cur.root, withinUid);
    if (!scopeRoot) return cur;

    const singleton = unresolvedNodes(scopeRoot).find((node) => {
      const feasibleChoices = annotateChoicesFor(graph, cur, node.uid).filter((x) => x.feasible);
      return feasibleChoices.length === 1;
    });

    if (!singleton) {
      return cur;
    }

    const feasibleChoices = annotateChoicesFor(graph, cur, singleton.uid).filter((x) => x.feasible);
    const only = feasibleChoices[0].choice;

    if (only.kind === 'leaf') {
      const next = cloneTree(cur);
      const n = findNode(next.root, singleton.uid);
      if (!n || n.kind !== 'choice') return cur;

      n.kind = 'leaf';
      n.prediction = only.leaf.prediction;
      n.leafId = only.leaf.id;
      n.feature = undefined;
      n.left = undefined;
      n.right = undefined;

      const unresolved = unresolvedNodes(next.root);
      next.activeUid = unresolved[0]?.uid ?? n.uid;
      cur = next;
      continue;
    }

    const next = cloneTree(cur);
    const n = findNode(next.root, singleton.uid);
    if (!n || n.kind !== 'choice') return cur;

    const s = only.split;

    n.kind = 'split';
    n.feature = s.feature;
    n.splitId = s.id;
    n.prediction = undefined;
    n.left = { uid: next.nextUid++, graphTrieId: s.left_trie_id, kind: 'choice' };
    n.right = { uid: next.nextUid++, graphTrieId: s.right_trie_id, kind: 'choice' };

    const unresolved = unresolvedNodes(next.root);
    next.activeUid = unresolved[0]?.uid ?? n.uid;
    cur = next;
  }
}

export function randomComplete(
  snapshot: HistorySnapshot,
  graph: AndOrGraph,
  rng: () => number = Math.random,
  targetUid: number = snapshot.activeUid,
): HistorySnapshot {
  let cur = autoExpandSingletons(cloneTree(snapshot), graph, targetUid);

  while (true) {
    const target = findNode(cur.root, targetUid);
    if (!target) return cur;

    const node = unresolvedNodes(target)[0];
    if (!node) break;

    const feasibleChoices = annotateChoicesFor(graph, cur, node.uid).filter((x) => x.feasible);

    if (feasibleChoices.length === 0) {
      return cur;
    }

    const ix = Math.floor(rng() * feasibleChoices.length);
    const chosen = feasibleChoices[ix].choice;

    if (chosen.kind === 'leaf') {
      cur = applyLeaf(cur, graph, node.uid, chosen.leaf.id, targetUid);
    } else {
      cur = applySplit(cur, graph, node.uid, chosen.split.id, targetUid);
    }
  }

  return cur;
}

function bestUnconstrainedPlan(
  graph: AndOrGraph,
  trieId: number,
  memo?: Map<number, CompletionPlan | undefined>,
): CompletionPlan | undefined {
  if (memo?.has(trieId)) return memo.get(trieId);

  const idx = buildIndex(graph);
  const trie = idx.trie.get(trieId);
  if (!trie) return undefined;

  let best: CompletionPlan | undefined;

  for (const leafId of trie.leaf_ids) {
    const leaf = idx.leaves.get(leafId);
    if (!leaf) continue;
    const candidate: CompletionPlan = {
      kind: 'leaf',
      leafId,
      objective: leafObjective(leaf),
    };
    if (!best || candidate.objective < best.objective) best = candidate;
  }

  for (const splitId of trie.split_ids) {
    const split = idx.splits.get(splitId);
    if (!split) continue;

    const left = bestUnconstrainedPlan(graph, split.left_trie_id, memo);
    const right = bestUnconstrainedPlan(graph, split.right_trie_id, memo);
    if (!left || !right) continue;

    const candidate: CompletionPlan = {
      kind: 'split',
      splitId,
      objective: left.objective + right.objective,
      left,
      right,
    };

    if (!best || candidate.objective < best.objective) best = candidate;
  }

  memo?.set(trieId, best);
  return best;
}

function bestAvoidingPlan(
  graph: AndOrGraph,
  trieId: number,
  forbidden: Set<number>,
): CompletionPlan | undefined {
  const idx = buildIndex(graph);
  const trie = idx.trie.get(trieId);
  if (!trie) return undefined;

  let best: CompletionPlan | undefined;

  for (const leafId of trie.leaf_ids) {
    const leaf = idx.leaves.get(leafId);
    if (!leaf) continue;
    const candidate: CompletionPlan = {
      kind: 'leaf',
      leafId,
      objective: leafObjective(leaf),
    };
    if (!best || candidate.objective < best.objective) best = candidate;
  }

  for (const splitId of trie.split_ids) {
    const split = idx.splits.get(splitId);
    if (!split || forbidden.has(split.feature)) continue;

    const left = bestAvoidingPlan(graph, split.left_trie_id, forbidden);
    const right = bestAvoidingPlan(graph, split.right_trie_id, forbidden);
    if (!left || !right) continue;

    const candidate: CompletionPlan = {
      kind: 'split',
      splitId,
      objective: left.objective + right.objective,
      left,
      right,
    };

    if (!best || candidate.objective < best.objective) best = candidate;
  }

  return best;
}

function bestPredictingPlan(
  graph: AndOrGraph,
  trieId: number,
  featureTruth: Record<string, boolean>,
  targetPrediction: number,
  constrainedMemo: Map<number, CompletionPlan | undefined>,
  freeMemo: Map<number, CompletionPlan | undefined>,
): CompletionPlan | undefined {
  if (constrainedMemo.has(trieId)) return constrainedMemo.get(trieId);

  const idx = buildIndex(graph);
  const trie = idx.trie.get(trieId);
  if (!trie) return undefined;

  let best: CompletionPlan | undefined;

  for (const leafId of trie.leaf_ids) {
    const leaf = idx.leaves.get(leafId);
    if (!leaf || Number(leaf.prediction) !== targetPrediction) continue;

    const candidate: CompletionPlan = {
      kind: 'leaf',
      leafId,
      objective: leafObjective(leaf),
    };
    if (!best || candidate.objective < best.objective) best = candidate;
  }

  for (const splitId of trie.split_ids) {
    const split = idx.splits.get(splitId);
    if (!split) continue;

    const branch = featureTruth[String(split.feature)];
    let left: CompletionPlan | undefined;
    let right: CompletionPlan | undefined;

    if (typeof branch === 'boolean') {
      const constrainedTrieId = branch ? split.left_trie_id : split.right_trie_id;
      const freeTrieId = branch ? split.right_trie_id : split.left_trie_id;

      const constrained = bestPredictingPlan(
        graph,
        constrainedTrieId,
        featureTruth,
        targetPrediction,
        constrainedMemo,
        freeMemo,
      );
      const free = bestUnconstrainedPlan(graph, freeTrieId, freeMemo);
      if (!constrained || !free) continue;

      left = branch ? constrained : free;
      right = branch ? free : constrained;
    } else {
      left = bestPredictingPlan(
        graph,
        split.left_trie_id,
        featureTruth,
        targetPrediction,
        constrainedMemo,
        freeMemo,
      );
      right = bestPredictingPlan(
        graph,
        split.right_trie_id,
        featureTruth,
        targetPrediction,
        constrainedMemo,
        freeMemo,
      );
      if (!left || !right) continue;
    }

    const candidate: CompletionPlan = {
      kind: 'split',
      splitId,
      objective: left.objective + right.objective,
      left,
      right,
    };

    if (!best || candidate.objective < best.objective) best = candidate;
  }

  constrainedMemo.set(trieId, best);
  return best;
}

function buildFromPlan(
  graph: AndOrGraph,
  uid: number,
  graphTrieId: number,
  plan: CompletionPlan,
  nextUid: { value: number },
): BuildNode | undefined {
  const idx = buildIndex(graph);

  if (plan.kind === 'leaf') {
    const leaf = idx.leaves.get(plan.leafId);
    if (!leaf) return undefined;

    return {
      uid,
      graphTrieId,
      kind: 'leaf',
      prediction: leaf.prediction,
      leafId: leaf.id,
    };
  }

  const split = idx.splits.get(plan.splitId);
  if (!split) return undefined;

  const leftUid = nextUid.value++;
  const rightUid = nextUid.value++;

  const left = buildFromPlan(graph, leftUid, split.left_trie_id, plan.left, nextUid);
  const right = buildFromPlan(graph, rightUid, split.right_trie_id, plan.right, nextUid);
  if (!left || !right) return undefined;

  return {
    uid,
    graphTrieId,
    kind: 'split',
    feature: split.feature,
    splitId: split.id,
    left,
    right,
  };
}

function fillFrontierFromPlans(
  snapshot: HistorySnapshot,
  graph: AndOrGraph,
  plans: Map<number, CompletionPlan>,
  targetUid: number,
): HistorySnapshot | undefined {
  const next = cloneTree(snapshot);
  const nextUid = { value: next.nextUid };

  for (const [uid, plan] of plans.entries()) {
    const node = findNode(next.root, uid);
    if (!node || node.kind !== 'choice') return undefined;

    const built = buildFromPlan(graph, node.uid, node.graphTrieId, plan, nextUid);
    if (!built) return undefined;
    Object.assign(node, built);
  }

  next.nextUid = nextUid.value;
  const unresolved = unresolvedNodes(next.root);
  next.activeUid = unresolved[0]?.uid ?? targetUid;
  return next;
}

function setConstraintResult(ok: boolean, message: string) {
  window.ARBORENUM_CONSTRAINED_COMPLETION_RESULT = { ok, message };
}

function constrainedAvoidComplete(
  snapshot: HistorySnapshot,
  graph: AndOrGraph,
  forbiddenFeatures: number[],
  targetUid: number,
): HistorySnapshot {
  const scopeRoot = findNode(snapshot.root, targetUid);
  if (!scopeRoot) {
    setConstraintResult(false, 'The selected subtree could not be found.');
    return snapshot;
  }

  const frontier = unresolvedNodes(scopeRoot);
  if (frontier.length === 0) {
    setConstraintResult(false, 'The selected subtree has no unfinished choices to complete.');
    return snapshot;
  }

  const forbidden = new Set(forbiddenFeatures.map(Number));

  const alreadyUsed = walk(scopeRoot).find(
    (node) => node.kind === 'split' && node.feature !== undefined && forbidden.has(node.feature),
  );

  if (alreadyUsed) {
    setConstraintResult(
      false,
      'A selected feature is already used in the selected subtree. Rewind that split first if this subtree must avoid it.',
    );
    return snapshot;
  }

  const plans = new Map<number, CompletionPlan>();

  for (const node of frontier) {
    const plan = bestAvoidingPlan(graph, node.graphTrieId, forbidden);
    if (!plan) {
      setConstraintResult(false, 'No completion exists in the selected subtree that avoids the selected features.');
      return snapshot;
    }
    plans.set(node.uid, plan);
  }

  const next = fillFrontierFromPlans(snapshot, graph, plans, targetUid);
  if (!next) {
    setConstraintResult(false, 'Could not construct the constrained completion.');
    return snapshot;
  }

  if (lowerBound(graph, next.root) > rootBudget(graph) + 1e-9) {
    setConstraintResult(
      false,
      'No completion of the selected subtree that avoids the selected features fits within the Rashomon budget.',
    );
    return snapshot;
  }

  setConstraintResult(true, 'Built the optimal constrained completion for the selected subtree.');
  return next;
}

type PartialRouteResult = {
  frontier: BuildNode[];
  leaves: BuildNode[];
  error?: string;
};

function routePartialSample(
  node: BuildNode,
  featureTruth: Record<string, boolean>,
  out: PartialRouteResult,
): void {
  if (out.error) return;

  if (node.kind === 'choice') {
    out.frontier.push(node);
    return;
  }

  if (node.kind === 'leaf') {
    out.leaves.push(node);
    return;
  }

  if (!node.left || !node.right) {
    out.error = 'The partial tree has a missing child.';
    return;
  }

  const branch = featureTruth[String(node.feature)];

  if (typeof branch === 'boolean') {
    routePartialSample(branch ? node.left : node.right, featureTruth, out);
    return;
  }

  routePartialSample(node.left, featureTruth, out);
  routePartialSample(node.right, featureTruth, out);
}

function constrainedSampleComplete(
  snapshot: HistorySnapshot,
  graph: AndOrGraph,
  featureTruth: Record<string, boolean>,
  targetPrediction: number,
  targetUid: number,
): HistorySnapshot {
  const scopeRoot = findNode(snapshot.root, targetUid);
  if (!scopeRoot) {
    setConstraintResult(false, 'The selected subtree could not be found.');
    return snapshot;
  }

  const scopeFrontier = unresolvedNodes(scopeRoot);
  if (scopeFrontier.length === 0) {
    setConstraintResult(false, 'The selected subtree has no unfinished choices to complete.');
    return snapshot;
  }

  const route: PartialRouteResult = { frontier: [], leaves: [] };
  routePartialSample(scopeRoot, featureTruth, route);

  if (route.error) {
    setConstraintResult(false, route.error);
    return snapshot;
  }

  const conflictingLeaf = route.leaves.find(
    (leaf) => Number(leaf.prediction) !== targetPrediction,
  );

  if (conflictingLeaf) {
    setConstraintResult(
      false,
      `Some samples consistent with the entered values already reach an existing leaf in the selected subtree with prediction ${String(
        conflictingLeaf.prediction,
      )}. Rewind that branch before requiring class ${String(targetPrediction)}.`,
    );
    return snapshot;
  }

  const constrainedFrontier = new Set(route.frontier.map((node) => node.uid));
  const plans = new Map<number, CompletionPlan>();
  const constrainedMemo = new Map<number, CompletionPlan | undefined>();
  const freeMemo = new Map<number, CompletionPlan | undefined>();

  for (const node of scopeFrontier) {
    const plan = constrainedFrontier.has(node.uid)
      ? bestPredictingPlan(
          graph,
          node.graphTrieId,
          featureTruth,
          targetPrediction,
          constrainedMemo,
          freeMemo,
        )
      : bestUnconstrainedPlan(graph, node.graphTrieId, freeMemo);

    if (!plan) {
      setConstraintResult(
        false,
        constrainedFrontier.has(node.uid)
          ? `No completion of the selected subtree can guarantee class ${String(
              targetPrediction,
            )} for every sample consistent with the entered values.`
          : 'Could not optimally complete one of the remaining nodes in the selected subtree.',
      );
      return snapshot;
    }

    plans.set(node.uid, plan);
  }

  const next = fillFrontierFromPlans(snapshot, graph, plans, targetUid);
  if (!next) {
    setConstraintResult(false, 'Could not construct the constrained completion.');
    return snapshot;
  }

  if (lowerBound(graph, next.root) > rootBudget(graph) + 1e-9) {
    setConstraintResult(
      false,
      `No completion of the selected subtree that guarantees class ${String(
        targetPrediction,
      )} for every sample consistent with the entered values fits within the Rashomon budget.`,
    );
    return snapshot;
  }

  setConstraintResult(
    true,
    `Built the optimal completion of the selected subtree guaranteeing class ${String(
      targetPrediction,
    )} for every sample consistent with the entered values.`,
  );
  return next;
}

export function optimalComplete(
  snapshot: HistorySnapshot,
  graph: AndOrGraph,
  targetUid: number = snapshot.activeUid,
): HistorySnapshot {
  const constraint = window.ARBORENUM_CONSTRAINED_COMPLETION;

  if (constraint?.mode === 'avoid') {
    return constrainedAvoidComplete(
      snapshot,
      graph,
      constraint.forbiddenInternalFeatures,
      targetUid,
    );
  }

  if (constraint?.mode === 'sample') {
    return constrainedSampleComplete(
      snapshot,
      graph,
      constraint.featureTruth,
      Number(constraint.targetPrediction),
      targetUid,
    );
  }

  let cur = autoExpandSingletons(cloneTree(snapshot), graph, targetUid);

  while (true) {
    const target = findNode(cur.root, targetUid);
    if (!target) return cur;

    const node = unresolvedNodes(target)[0];
    if (!node) break;

    const feasibleChoices = annotateChoicesFor(graph, cur, node.uid)
      .filter((x) => x.feasible);

    if (feasibleChoices.length === 0) {
      return cur;
    }

    let best = feasibleChoices[0];

    for (let i = 1; i < feasibleChoices.length; i++) {
      if (feasibleChoices[i].objective < best.objective) {
        best = feasibleChoices[i];
      }
    }

    const chosen = best.choice;

    if (chosen.kind === 'leaf') {
      cur = applyLeaf(cur, graph, node.uid, chosen.leaf.id, targetUid);
    } else {
      cur = applySplit(cur, graph, node.uid, chosen.split.id, targetUid);
    }
  }

  return cur;
}

export function featureLabel(feature: number | undefined, meta: FeatureMeta): string {
  if (feature == null) return '';
  const names = meta.featureNames ?? [];
  return names[feature] ?? `f${feature}`;
}

export function thresholdLabel(feature: number, meta: FeatureMeta): string {
  const raw = Array.isArray(meta.thresholds) ? meta.thresholds[feature] : meta.thresholds?.[String(feature)];
  if (raw == null) return featureLabel(feature, meta);
  const n = Number(raw);
  return Number.isFinite(n) ? n.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : String(raw);
}

export function groupName(feature: number, meta: FeatureMeta): string | undefined {
  const g = meta.continuousGroups;
  if (!g) return undefined;
  if (Array.isArray(g)) {
    const ix = g.findIndex((cols) => cols.includes(feature));
    return ix >= 0 ? `group_${ix}` : undefined;
  }
  return Object.entries(g).find(([, cols]) => cols.includes(feature))?.[0];
}

export function treePaths(root: BuildNode): Array<{ path: string[]; prediction: number }> {
  const out: Array<{ path: string[]; prediction: number }> = [];
  const dfs = (n: BuildNode, path: string[]) => {
    if (n.kind === 'leaf') {
      out.push({ path, prediction: n.prediction ?? 0 });
      return;
    }
    if (n.kind === 'split') {
      dfs(n.left!, [...path, `+${n.feature}`]);
      dfs(n.right!, [...path, `-${n.feature}`]);
    }
  };
  dfs(root, []);
  return out;
}

export function isComplete(root: BuildNode): boolean {
  return unresolvedNodes(root).length === 0;
}
