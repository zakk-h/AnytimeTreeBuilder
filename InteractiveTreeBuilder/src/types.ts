export type TrieNode = {
  id: number;
  leaf_ids: number[];
  split_ids: number[];
  budget?: number;
  min_objective?: number;
  subproblem_size?: number;
};

export type SplitNode = {
  id: number;
  parent_trie_id: number;
  feature: number;
  left_trie_id: number;
  right_trie_id: number;
  min_objective?: number;
  objective?: number;
  count?: number;
};

export type LeafNode = {
  id: number;
  parent_trie_id: number;
  prediction: number;
  loss?: number;
  subproblem_size?: number;
  objective?: number;
  count?: number;
};

export type AndOrGraph = {
  root_trie_id: number;
  trie_nodes: TrieNode[];
  split_nodes: SplitNode[];
  leaf_nodes: LeafNode[];
  metadata?: Record<string, unknown>;
};

export type FeatureMeta = {
  featureNames?: string[];
  continuousGroups?: Record<string, number[]> | number[][];
  thresholds?: Record<string, number | string> | Array<number | string | null>;
  featureDescriptions?: Record<string, string>;
};

export type BuildNodeKind = 'choice' | 'split' | 'leaf';

export type BuildNode = {
  uid: number;
  graphTrieId: number;
  kind: BuildNodeKind;
  feature?: number;
  prediction?: number;
  splitId?: number;
  leafId?: number;
  left?: BuildNode;
  right?: BuildNode;
};

export type Choice =
  | { kind: 'split'; split: SplitNode }
  | { kind: 'leaf'; leaf: LeafNode };

export type ChoiceBudget = {
  choice: Choice;
  objective: number;
  feasible: boolean;
  excess: number;
};

export type NodeBudget = {
  rootBudget: number;
  rootSize: number;
  currentLowerBound: number;
  otherLowerBound: number;
  nodeBestObjective: number;
  nodeAvailableBudget: number;
  globalSlack: number;
};

export type HistorySnapshot = {
  root: BuildNode;
  activeUid: number;
  nextUid: number;
};
