import {
  type CSSProperties,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow,
  Controls,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeChange,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { AnimatePresence, motion } from 'framer-motion';
import {
  Ban,
  CircleDot,
  Download,
  RotateCcw,
  Search,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Network,
  ChevronRight,
} from 'lucide-react';

import type {
  AndOrGraph,
  BuildNode,
  ChoiceBudget,
  FeatureMeta,
  HistorySnapshot,
} from './types';

import { sampleGraph, sampleMeta } from './sampleData';

import {
  annotateChoicesFor,
  applyLeaf,
  applySplit,
  choicesFor,
  featureLabel,
  findNode,
  formatObjective,
  groupName,
  isComplete,
  lowerBound,
  makeRoot,
  nodeBudgetFor,
  normalizedObjective,
  rewind,
  rootBudget,
  rootSize,
  thresholdLabel,
  treePaths,
  trieMinObjective,
  unresolvedNodes,
  autoExpandSingletons,
  randomComplete,
  optimalComplete,
} from './graphUtils';

import { layoutTree } from './layout';
import './style.css';
import { LiveEnumerationPanel } from './LiveEnumerationPanel';
import { UploadMenu } from './UploadMenu';
import { NativeGraphAdapter, nativeApi, type NativeNodeView, type NativeCompletion, type NativeConstraint } from './nativeGraph';
import type { ArborEnumBuilderMeta } from './arborenumPayload';
import { normalizeArborEnumPayload, rememberCurrentPayload } from './arborenumPayload';

declare global {
  interface Window {
    ARBORENUM_ANDOR_GRAPH?: AndOrGraph;
    ARBORENUM_ANDOR_META?: FeatureMeta & Record<string, unknown>;

    ARBORENUM_BUILDER_PAYLOAD?: {
      graph?: AndOrGraph;
      meta?: FeatureMeta & Record<string, unknown>;

      feature_names?: string[];
      featureNames?: string[];

      continuous_groups?: Record<string, number[]>;
      continuousGroups?: Record<string, number[]>;

      thresholds?: Record<string, unknown>;

      feature_descriptions?: Record<string, string>;
      featureDescriptions?: Record<string, string>;

      gamma?: number;
      lambda_reg?: number;
      lambdaReg?: number;
    };
  }
}

type BuilderColors = {
  splitNode: string;
  leafNode: string;
  leafNodesByClass: Record<string, string>;
  edge: string;
  background: string;
};

type BuilderUi = {
  labelNames: Record<string, string>;
  featureNames: Record<string, string>;
  groupNames: Record<string, string>;
  featureDescriptions: Record<string, string>;
  binaryFeatureFlips: Record<string, boolean>;
  colors: BuilderColors;
};

type NodeData = {
  b: BuildNode;
  active: boolean;
  choices: number;
  feasibleChoices: number;
  meta: FeatureMeta & Record<string, unknown>;
  graph: AndOrGraph;
  thresholdDecimals: number;
  ui: BuilderUi;
};

type ChoiceGroupEntry = {
  name: string;
  choices: ChoiceBudget[];
  validCount: number;
  totalCount: number;
  bestObjective: number;
  collapsed: boolean;
  representativeFeature?: number;
};

const DEFAULT_COLORS: BuilderColors = {
  splitNode: '#ffffff',
  leafNode: '#eaf2e9',
  leafNodesByClass: {
    '-1': '#D1D5DB',
  },
  edge: '#9caeaa',
  background: '#f6f5f0',
};

const BINARY_GROUP_LABEL = 'Binary features';
const DEFAULT_FEATURE_DESCRIPTION = 'A description for this feature can be added here.';

function makeDefaultUi(): BuilderUi {
  return {
    labelNames: {},
    featureNames: {},
    groupNames: {},
    featureDescriptions: {},
    binaryFeatureFlips: {},
    colors: {
      ...DEFAULT_COLORS,
      leafNodesByClass: { ...DEFAULT_COLORS.leafNodesByClass },
    },
  };
}

function predictionLabel(prediction: number | undefined, ui: BuilderUi): string {
  if (prediction === undefined || prediction === null) return 'predict —';

  if (Number(prediction) === -1) return 'defer';

  const custom = ui.labelNames[String(prediction)]?.trim();
  return custom || `predict ${prediction}`;
}

function continuousGroupEntries(meta: FeatureMeta): Array<{ key: string; features: number[] }> {
  const g = meta.continuousGroups;

  if (!g) return [];

  if (Array.isArray(g)) {
    return g.map((features, i) => ({
      key: `group_${i}`,
      features,
    }));
  }

  return Object.entries(g).map(([key, features]) => ({
    key,
    features,
  }));
}

function allSplitFeatures(graph: AndOrGraph): number[] {
  return Array.from(new Set(graph.split_nodes.map((s) => s.feature))).sort((a, b) => a - b);
}

function customGroupName(group: string, ui: BuilderUi): string {
  return ui.groupNames[group]?.trim() || group;
}

function customFeatureName(feature: number, meta: FeatureMeta, ui: BuilderUi): string {
  return ui.featureNames[String(feature)]?.trim() || featureLabel(feature, meta);
}

function featureRegistryEntry(
  feature: number,
  meta: FeatureMeta & Record<string, unknown>,
): Record<string, unknown> | undefined {
  const registry = meta.featureRegistry;
  if (!Array.isArray(registry)) return undefined;

  return registry.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return Number((entry as Record<string, unknown>).internalFeature) === feature;
  }) as Record<string, unknown> | undefined;
}

function isBinaryFeature(
  feature: number,
  meta: FeatureMeta & Record<string, unknown>,
): boolean {
  const registryKind = featureRegistryEntry(feature, meta)?.kind;
  if (registryKind === 'binary_threshold') return true;
  if (registryKind === 'continuous_threshold') return false;
  return groupName(feature, meta) === undefined;
}

function binaryFeatureIsFlipped(
  feature: number,
  meta: FeatureMeta & Record<string, unknown>,
  ui: BuilderUi,
): boolean {
  return isBinaryFeature(feature, meta) && (ui.binaryFeatureFlips[String(feature)] ?? true);
}

function naturalBinaryFeatureName(
  feature: number,
  meta: FeatureMeta & Record<string, unknown>,
  ui: BuilderUi,
): string {
  const custom = ui.featureNames[String(feature)]?.trim();
  if (custom) return custom;

  const originalName = featureRegistryEntry(feature, meta)?.originalName;
  if (typeof originalName === 'string' && originalName.trim()) {
    return originalName.trim();
  }

  return featureLabel(feature, meta)
    .replace(/\s*(?:<=|>=|≤|≥|<|>|=)\s*-?\d+(?:\.\d+)?(?:e[-+]?\d+)?\s*$/i, '')
    .trim();
}

function displayGroupName(feature: number, meta: FeatureMeta, ui: BuilderUi): string | undefined {
  const group = groupName(feature, meta);
  return group ? customGroupName(group, ui) : undefined;
}

function descriptionKeyForFeature(feature: number, meta: FeatureMeta): string {
  const group = groupName(feature, meta);
  return group ? `group:${group}` : `feature:${feature}`;
}

function featureDescription(
  feature: number | undefined,
  meta: FeatureMeta & Record<string, unknown>,
  ui: BuilderUi,
): string {
  if (feature === undefined || feature === null) {
    return DEFAULT_FEATURE_DESCRIPTION;
  }

  const key = descriptionKeyForFeature(feature, meta);
  const custom = ui.featureDescriptions[key]?.trim();

  if (custom) {
    return custom;
  }

  const descriptions = meta.featureDescriptions as Record<string, string> | undefined;
  const group = groupName(feature, meta);

  if (group) {
    return (
      descriptions?.[`group:${group}`] ??
      descriptions?.[group] ??
      DEFAULT_FEATURE_DESCRIPTION
    );
  }

  return (
    descriptions?.[`feature:${feature}`] ??
    descriptions?.[String(feature)] ??
    DEFAULT_FEATURE_DESCRIPTION
  );
}

function cloneSnapshot(snapshot: HistorySnapshot): HistorySnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as HistorySnapshot;
}

function coerceMeta(
  payload: Window['ARBORENUM_BUILDER_PAYLOAD'],
): FeatureMeta & Record<string, unknown> {
  const payloadMeta = (payload?.meta ?? {}) as FeatureMeta & Record<string, unknown>;
  const globalMeta = (window.ARBORENUM_ANDOR_META ?? {}) as FeatureMeta & Record<string, unknown>;

  return {
    ...sampleMeta,
    ...globalMeta,
    ...payloadMeta,

    featureNames:
      payloadMeta.featureNames ??
      payload?.featureNames ??
      payload?.feature_names ??
      globalMeta.featureNames ??
      sampleMeta.featureNames,

    continuousGroups:
      payloadMeta.continuousGroups ??
      payload?.continuousGroups ??
      payload?.continuous_groups ??
      globalMeta.continuousGroups ??
      sampleMeta.continuousGroups,

    thresholds:
      payloadMeta.thresholds ??
      payload?.thresholds ??
      globalMeta.thresholds ??
      sampleMeta.thresholds,

    featureDescriptions:
      payloadMeta.featureDescriptions ??
      payload?.featureDescriptions ??
      payload?.feature_descriptions ??
      globalMeta.featureDescriptions ??
      sampleMeta.featureDescriptions ??
      {},

    gamma:
      payloadMeta.gamma ??
      payload?.gamma ??
      globalMeta.gamma ??
      sampleMeta.gamma,

    lambda_reg:
      payloadMeta.lambda_reg ??
      payload?.lambda_reg ??
      payload?.lambdaReg ??
      globalMeta.lambda_reg ??
      globalMeta.lambdaReg ??
      sampleMeta.lambda_reg ??
      sampleMeta.lambdaReg,
  } as FeatureMeta & Record<string, unknown>;
}

function stripZeros(x: string): string {
  return x.replace(/\.?0+$/, '');
}

function formatThresholdValue(value: unknown, decimals = 3): string {
  const num = Number(value);

  if (Number.isFinite(num)) {
    return stripZeros(num.toFixed(decimals));
  }

  return String(value);
}

function prettyThresholdLabel(
  feature: number,
  meta: FeatureMeta,
  thresholdDecimals = 3,
): string {
  return formatThresholdValue(thresholdLabel(feature, meta), thresholdDecimals);
}

function prettySplitLabel(
  feature: number,
  meta: FeatureMeta & Record<string, unknown>,
  thresholdDecimals = 3,
  ui: BuilderUi = makeDefaultUi(),
): string {
  const group = groupName(feature, meta);

  if (group) {
    return `${customGroupName(group, ui)} ≤ ${prettyThresholdLabel(
      feature,
      meta,
      thresholdDecimals,
    )}`;
  }

  if (binaryFeatureIsFlipped(feature, meta, ui)) {
    return naturalBinaryFeatureName(feature, meta, ui);
  }

  const raw = customFeatureName(feature, meta, ui);

  const formatted = raw.replace(
    /(<=|>=|<|>|=)\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/i,
    (_match, op, value) => `${op} ${formatThresholdValue(value, thresholdDecimals)}`,
  );

  return formatted;
}

function fullSplitLabel(
  feature: number | undefined,
  meta: FeatureMeta & Record<string, unknown>,
  thresholdDecimals = 3,
  ui: BuilderUi = makeDefaultUi(),
): string {
  if (feature === undefined || feature === null) return '';

  const group = groupName(feature, meta);

  if (group) {
    return `${customGroupName(group, ui)} ≤ ${prettyThresholdLabel(
      feature,
      meta,
      thresholdDecimals,
    )}`;
  }

  if (binaryFeatureIsFlipped(feature, meta, ui)) {
    return naturalBinaryFeatureName(feature, meta, ui);
  }

  return customFeatureName(feature, meta, ui).replace(
    /(<=|>=|<|>|=)\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/i,
    (_match, op, value) => `${op} ${formatThresholdValue(value, thresholdDecimals)}`,
  );
}

function displayTreeForUi(
  node: BuildNode,
  meta: FeatureMeta & Record<string, unknown>,
  ui: BuilderUi,
): BuildNode {
  const displayNode: BuildNode = {
    ...node,
    left: node.left ? displayTreeForUi(node.left, meta, ui) : undefined,
    right: node.right ? displayTreeForUi(node.right, meta, ui) : undefined,
  };

  if (
    node.kind === 'split' &&
    node.feature !== undefined &&
    binaryFeatureIsFlipped(node.feature, meta, ui)
  ) {
    [displayNode.left, displayNode.right] = [displayNode.right, displayNode.left];
  }

  return displayNode;
}

function gammaRaw(
  graph: AndOrGraph,
  meta: FeatureMeta & Record<string, unknown>,
): number | undefined {
  const explicit =
    meta.gamma ??
    meta.leafPenalty ??
    meta.leaf_penalty ??
    meta.lambda_gamma;

  const explicitNum = Number(explicit);
  if (Number.isFinite(explicitNum)) {
    return explicitNum;
  }

  const lambdaValue = meta.lambda_reg ?? meta.lambdaReg ?? meta.lambda;
  const lambdaNum = Number(lambdaValue);

  if (Number.isFinite(lambdaNum)) {
    return Math.round(lambdaNum * rootSize(graph));
  }

  return undefined;
}

function llroundNonnegative(x: number): number {
  return Math.floor(x + 0.5);
}

function etaDeferRaw(meta: FeatureMeta & Record<string, unknown>): number {
  const eta = Number(meta.eta_defer);
  return Number.isFinite(eta) ? eta : 0;
}

function leafById(
  graph: AndOrGraph,
  leafId?: number,
):
  | {
      id: number;
      prediction?: number;
      loss?: number;
      objective?: number;
      subproblem_size?: number;
      count?: number;
    }
  | undefined {
  if (leafId === undefined || leafId === null) return undefined;

  return graph.leaf_nodes.find((x) => x.id === leafId) as
    | {
        id: number;
        prediction?: number;
        loss?: number;
        objective?: number;
        subproblem_size?: number;
        count?: number;
      }
    | undefined;
}

function leafSampleSize(graph: AndOrGraph, leafId?: number): number | undefined {
  const leaf = leafById(graph, leafId);
  const n = Number(leaf?.subproblem_size ?? leaf?.count);

  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function leafSampleSizeLabel(graph: AndOrGraph, leafId?: number): string {
  const n = leafSampleSize(graph, leafId);
  return n === undefined ? 'n=—' : `n=${n}`;
}

function leafMistakesRaw(
  graph: AndOrGraph,
  meta: FeatureMeta & Record<string, unknown>,
  leafId?: number,
): number | undefined {
  const leaf = leafById(graph, leafId);

  if (!leaf || leaf.loss === undefined) {
    return undefined;
  }

  const gamma = gammaRaw(graph, meta);

  if (gamma === undefined) {
    return undefined;
  }

  const n = leafSampleSize(graph, leafId);
  const loss = Number(leaf.loss);

  if (n === undefined || n <= 0 || !Number.isFinite(loss)) {
    return undefined;
  }

  if (Number(leaf.prediction) === -1) {
    const eta = etaDeferRaw(meta);
    return Math.max(0, loss - gamma - llroundNonnegative(eta * n));
  }

  return Math.max(0, loss - gamma);
}

function completedTreeStats(
  graph: AndOrGraph,
  meta: FeatureMeta & Record<string, unknown>,
  root: BuildNode,
):
  | {
      totalN: number;
      leafN: number;
      deferredN: number;
      mistakes: number;
      accuracy: number;
      deferralRate: number;
      hasDeferral: boolean;
    }
  | undefined {
  if (!isComplete(root)) return undefined;

  const totalN = rootSize(graph);
  let leafN = 0;
  let deferredN = 0;
  let mistakes = 0;

  const collect = (node?: BuildNode) => {
    if (!node) return;

    if (node.kind === 'leaf') {
      const leaf = leafById(graph, node.leafId);
      const n = leafSampleSize(graph, node.leafId);

      if (n !== undefined) {
        leafN += n;

        if (Number(leaf?.prediction) === -1) {
          deferredN += n;
        }
      }

      const leafMistakes = leafMistakesRaw(graph, meta, node.leafId);

      if (leafMistakes !== undefined) {
        mistakes += leafMistakes;
      }

      return;
    }

    collect(node.left);
    collect(node.right);
  };

  collect(root);

  if (!Number.isFinite(totalN) || totalN <= 0) {
    return undefined;
  }

  return {
    totalN,
    leafN,
    deferredN,
    mistakes,
    accuracy: (totalN - mistakes) / totalN,
    deferralRate: deferredN / totalN,
    hasDeferral: deferredN > 0,
  };
}

function leafMisclassificationRate(
  graph: AndOrGraph,
  meta: FeatureMeta & Record<string, unknown>,
  leafId?: number,
): string {
  const n = leafSampleSize(graph, leafId);

  if (n === undefined || n <= 0) {
    return 'err —';
  }

  const mistakes = leafMistakesRaw(graph, meta, leafId);

  if (mistakes === undefined) {
    return gammaRaw(graph, meta) === undefined ? 'err needs γ' : 'err —';
  }

  const pct = (100 * mistakes) / n;

  return `${stripZeros(pct.toFixed(2))}% err`;
}

function ArborEnumNode({ data }: { data: NodeData }) {
  const { b, active, choices, feasibleChoices, meta, graph, thresholdDecimals, ui } = data;

  const icon =
    b.kind === 'split' || b.kind === 'leaf' ? null : (
      <CircleDot size={30} />
    );

  const title =
    b.kind === 'split'
      ? prettySplitLabel(b.feature ?? -1, meta, thresholdDecimals, ui)
      : b.kind === 'leaf'
        ? predictionLabel(b.prediction, ui)
        : graph.metadata?.native && graph.metadata.active_uid !== b.uid
          ? 'Select to explore'
          : `${feasibleChoices}/${choices} choices`;

  const subtitle =
    b.kind === 'split'
      ? ''
      : b.kind === 'leaf'
        ? `${leafSampleSizeLabel(graph, b.leafId)} · ${leafMisclassificationRate(
            graph,
            meta,
            b.leafId,
          )}`
        : `best ${formatObjective(graph, lowerBound(graph, b))}`;

  const description =
    b.kind === 'split'
      ? featureDescription(b.feature, meta, ui)
      : undefined;

  const nodeStyle =
    b.kind === 'leaf'
      ? ({
          '--leaf-node-bg':
            ui.colors.leafNodesByClass[String(b.prediction)] ||
            ui.colors.leafNode,
        } as CSSProperties)
      : undefined;

  return (
    <div
      className={`arborenum-node arborenum-node-${b.kind} ${active ? 'active' : ''}`}
      style={nodeStyle}
    >
      <Handle type="target" position={Position.Top} className="handle" />

      <div className="node-icon">{icon}</div>

      <div className="node-copy">
        <div className="node-eyebrow">{b.kind === 'split' ? 'Split rule' : b.kind === 'leaf' ? 'Prediction' : 'Decision point'}<span>#{b.uid}</span></div>
        <div
          className="node-title"
          title={b.kind === 'split' ? fullSplitLabel(b.feature, meta, thresholdDecimals, ui) : title}
        >
          {title}
        </div>
        {subtitle && <div className="node-subtitle">{subtitle}</div>}
      </div>

      {b.kind === 'split' && description && (
        <div className="node-description-popover">
          {description}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="handle" />
    </div>
  );
}

const nodeTypes = {
  arborenum: ArborEnumNode,
};

function downloadJson(name: string, x: unknown) {
  const blob = new Blob([JSON.stringify(x, null, 2)], {
    type: 'application/json',
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = name;
  a.click();

  URL.revokeObjectURL(url);
}

function readJsonFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)));
      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function SplitButton({
  annotated,
  graph,
  meta,
  thresholdDecimals,
  ui,
  onClick,
}: {
  annotated: ChoiceBudget;
  graph: AndOrGraph;
  meta: FeatureMeta & Record<string, unknown>;
  thresholdDecimals: number;
  ui: BuilderUi;
  onClick: () => void;
}) {
  const { choice, objective, feasible, excess } = annotated;
  const excessValue = excess ?? 0;

  const disabledTitle = feasible
    ? undefined
    : `Not feasible under the current partial tree. Free ${formatObjective(
        graph,
        excessValue,
      )} objective somewhere else, then this choice can become available again.`;

  const clickCard = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (feasible) onClick();
  };

  if (choice.kind === 'leaf') {
    return (
      <div
        className={`choice-card leaf-choice ${
          feasible ? '' : 'choice-card-disabled'
        }`}
        onClick={clickCard}
        onKeyDown={event => { if (feasible && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onClick(); } }}
        role="button"
        aria-disabled={!feasible}
        tabIndex={feasible ? 0 : -1}
        title={disabledTitle}
      >
        {!feasible && (
          <div className="blocked-mark">
            <Ban size={15} />
          </div>
        )}

        <div className="choice-card-main">
          Leaf prediction {predictionLabel(choice.leaf.prediction, ui)}
        </div>

        <div className="choice-card-sub">
          {leafSampleSizeLabel(graph, choice.leaf.id)} ·{' '}
          {leafMisclassificationRate(graph, meta, choice.leaf.id)} · obj{' '}
          {formatObjective(graph, objective)}
          {!feasible ? ` · over by ${formatObjective(graph, excessValue)}` : ''}
        </div>
      </div>
    );
  }

  const f = choice.split.feature;

  return (
    <div
      className={`choice-card split-choice ${
        feasible ? '' : 'choice-card-disabled'
      }`}
      onClick={clickCard}
      onKeyDown={event => { if (feasible && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onClick(); } }}
      role="button"
      aria-disabled={!feasible}
      tabIndex={feasible ? 0 : -1}
      title={disabledTitle}
    >
      {!feasible && (
        <div className="blocked-mark">
          <Ban size={15} />
        </div>
      )}

      <div className="choice-card-main split-choice-main">
        <span>{prettySplitLabel(f, meta, thresholdDecimals, ui)}</span>
      </div>

      <div className="choice-card-sub">
        obj {formatObjective(graph, objective)} · feature {f} · split #
        {choice.split.id}
        {!feasible ? ` · over by ${formatObjective(graph, excessValue)}` : ''}
      </div>
    </div>
  );
}

function SidePanel({
  graph,
  meta,
  snapshot,
  active,
  thresholdDecimals,
  ui,
  onApplySplit,
  onApplyLeaf,
  onSetActive,
  onReset,
  onRandom,
  onOptimal,
  onUndo,
  canUndo,
}: {
  graph: AndOrGraph;
  meta: FeatureMeta & Record<string, unknown>;
  snapshot: HistorySnapshot;
  active?: BuildNode;
  thresholdDecimals: number;
  ui: BuilderUi;
  onApplySplit: (splitId: number) => void;
  onApplyLeaf: (leafId: number) => void;
  onSetActive: (uid: number) => void;
  onReset: () => void;
  onRandom: () => void;
  onOptimal: () => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  const [query, setQuery] = useState('');
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [openDescriptionKey, setOpenDescriptionKey] = useState<string | null>(null);

  useEffect(() => {
    setExpandedGroup(null);
    setQuery('');
    setOpenDescriptionKey(null);
  }, [active?.uid]);

  const unresolved = unresolvedNodes(snapshot.root);

  const nativeOptionsReady = !graph.metadata?.native || graph.metadata.active_uid === active?.uid;
  const activeChoices =
    active && active.kind === 'choice' && nativeOptionsReady
      ? annotateChoicesFor(graph, snapshot, active.uid)
      : [];

  const budget =
    active && active.kind === 'choice'
      ? nodeBudgetFor(graph, snapshot, active.uid)
      : undefined;

  const currentLower = lowerBound(graph, snapshot.root);
  const rootLimit = rootBudget(graph);
  const rootMinimum = trieMinObjective(graph, graph.root_trie_id);
  const initialSlack = Math.max(0, rootLimit - rootMinimum);
  const remainingSlack = Math.max(0, rootLimit - currentLower);
  const slackFraction =
    Number.isFinite(initialSlack) && initialSlack > 1e-9
      ? Math.max(0, Math.min(1, remainingSlack / initialSlack))
      : 0;
  const slackPercent = Math.round(100 * slackFraction);
  const feasibleTotal = activeChoices.filter((x) => x.feasible).length;
  const completeStats = completedTreeStats(graph, meta, snapshot.root);

  const q = query.trim().toLowerCase();

  const filtered = activeChoices.filter((x) => {
    const c = x.choice;

    if (!q) return true;

    if (c.kind === 'leaf') {
      return `leaf ${predictionLabel(c.leaf.prediction, ui)} ${leafMisclassificationRate(
        graph,
        meta,
        c.leaf.id,
      )} objective ${formatObjective(graph, x.objective)}`
        .toLowerCase()
        .includes(q);
    }

    return `${prettySplitLabel(c.split.feature, meta, thresholdDecimals, ui)} ${
      displayGroupName(c.split.feature, meta, ui) ?? ''
    } ${featureDescription(c.split.feature, meta, ui)} ${prettyThresholdLabel(
      c.split.feature,
      meta,
      thresholdDecimals,
    )} objective ${formatObjective(graph, x.objective)}`
      .toLowerCase()
      .includes(q);
  });

  const makeChoiceGroups = (feasibleXs: ChoiceBudget[], allXs: ChoiceBudget[]) => {
    const grouped = new Map<string, ChoiceBudget[]>();
    const totalByGroup = new Map<string, number>();
    const leaves: ChoiceBudget[] = [];
    const totalLeaves = allXs.filter((x) => x.choice.kind === 'leaf').length;

    for (const c of allXs) {
      if (c.choice.kind === 'split') {
        const key =
          displayGroupName(c.choice.split.feature, meta, ui) ??
          BINARY_GROUP_LABEL;
        totalByGroup.set(key, (totalByGroup.get(key) ?? 0) + 1);
      }
    }

    for (const c of feasibleXs) {
      if (c.choice.kind === 'leaf') {
        leaves.push(c);
      } else {
        const key =
          displayGroupName(c.choice.split.feature, meta, ui) ??
          BINARY_GROUP_LABEL;

        grouped.set(key, [...(grouped.get(key) ?? []), c]);
      }
    }

    const sortedGroupEntries: ChoiceGroupEntry[] = Array.from(grouped.entries()).map(([name, choices]) => {
      const sorted = [...choices].sort((a, b) => {
        if (a.choice.kind !== 'split' || b.choice.kind !== 'split') return 0;

        return prettyThresholdLabel(a.choice.split.feature, meta, thresholdDecimals).localeCompare(
          prettyThresholdLabel(b.choice.split.feature, meta, thresholdDecimals),
          undefined,
          { numeric: true },
        );
      });

      const bestObjective = Math.min(...sorted.map((x) => x.objective));
      const representative = sorted.find((x) => x.choice.kind === 'split');

      return {
        name,
        choices: sorted,
        validCount: sorted.length,
        totalCount: totalByGroup.get(name) ?? sorted.length,
        bestObjective,
        collapsed: name !== BINARY_GROUP_LABEL && sorted.length > 4,
        representativeFeature:
          representative?.choice.kind === 'split'
            ? representative.choice.split.feature
            : undefined,
      };
    });

    return { leaves, totalLeaves, sortedGroupEntries };
  };

  const feasibleFiltered = filtered.filter((x) => x.feasible);

  const { leaves, totalLeaves, sortedGroupEntries } = makeChoiceGroups(
    feasibleFiltered,
    filtered,
  );

  const expandedEntry =
    expandedGroup === null
      ? undefined
      : sortedGroupEntries.find((g) => g.name === expandedGroup);

  const visibleGroupEntries =
    expandedGroup === null
      ? sortedGroupEntries
      : expandedEntry
        ? [expandedEntry]
        : [];

  const paths = treePaths(snapshot.root);

  const continuousDescriptionForEntry = (entry: ChoiceGroupEntry) => {
    const feature = entry.representativeFeature;

    if (feature === undefined || feature === null) {
      return undefined;
    }

    const group = groupName(feature, meta);

    if (!group) {
      return undefined;
    }

    const key = descriptionKeyForFeature(feature, meta);

    return {
      key,
      open: openDescriptionKey === key,
      text: featureDescription(feature, meta, ui),
    };
  };

  return (
    <aside className="panel">
      <div className="brand">
        <div className="brand-badge">
          <Sparkles size={19} />
        </div>
        <div>
          <div className="brand-title">Tree overview</div>
          <div className="brand-subtitle">Every choice stays within your budget.</div>
        </div>
      </div>

      <div className="metric-grid">
        <div className="metric">
          <b>{formatObjective(graph, currentLower)}</b>
          <span>current lower bound</span>
        </div>
        <div className="metric">
          <b>{formatObjective(graph, rootLimit)}</b>
          <span>Rashomon budget</span>
        </div>
        <div className="metric">
          <b>{formatObjective(graph, remainingSlack)}</b>
          <span>remaining slack</span>
        </div>
        <div className="metric">
          <b>{rootSize(graph).toLocaleString()}</b>
          <span>training samples</span>
        </div>
      </div>

      <div className="rashomon-slack-card">
        <div className="rashomon-slack-head">
          <span>Rashomon slack remaining</span>
          <b>{slackPercent}%</b>
        </div>
        <div
          className="rashomon-slack-track"
          role="progressbar"
          aria-label="Rashomon slack remaining"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={slackPercent}
        >
          <div
            className="rashomon-slack-fill"
            style={{ width: `${slackPercent}%` }}
          />
        </div>
        <div className="rashomon-slack-foot">
          <span>{formatObjective(graph, remainingSlack)} remaining</span>
          <span>{formatObjective(graph, initialSlack)} originally</span>
        </div>
      </div>

      <div className="toolbar-row">
        <button className="ghost-button" onClick={onUndo} disabled={!canUndo}>
          <Undo2 size={15} /> Undo
        </button>

        <button className="ghost-button" onClick={onReset}>
          <RotateCcw size={15} /> Reset
        </button>

        <button
          className="ghost-button"
          onClick={onRandom}
          disabled={isComplete(snapshot.root)}
        >
          <Shuffle size={15} /> Random
        </button>

        <button
          className="ghost-button"
          onClick={onOptimal}
          disabled={isComplete(snapshot.root)}
        >
          <Sparkles size={15} /> Optimal
        </button>

        <button
          className="ghost-button"
          onClick={() =>
            downloadJson('interactive-tree.json', {
              complete: isComplete(snapshot.root),
              objective_lower_bound: currentLower,
              normalized_objective_lower_bound: normalizedObjective(
                graph,
                currentLower,
              ),
              paths,
              tree: snapshot.root,
            })
          }
        >
          <Download size={15} /> Export
        </button>
      </div>

      {completeStats && (
        <section className="panel-section">
          <div className="section-title">Completed Tree</div>

          <div className="budget-box">
            <div>
              <span>accuracy</span>
              <b>{stripZeros((100 * completeStats.accuracy).toFixed(2))}%</b>
            </div>

            <div>
              <span>mistakes</span>
              <b>
                {stripZeros(completeStats.mistakes.toFixed(2))}/{completeStats.totalN}
              </b>
            </div>

            {completeStats.hasDeferral && (
              <div>
                <span>deferral rate</span>
                <b>{stripZeros((100 * completeStats.deferralRate).toFixed(2))}%</b>
              </div>
            )}

            {completeStats.hasDeferral && (
              <div>
                <span>deferred n</span>
                <b>
                  {completeStats.deferredN}/{completeStats.totalN}
                </b>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="panel-section">
        <div className="section-title">Remaining Choices</div>

        <div className="frontier-list">
          {unresolved.map((n) => {
            const ann = annotateChoicesFor(graph, snapshot, n.uid);
            const feasible = ann.filter((x) => x.feasible).length;

            return (
              <button
                key={n.uid}
                className={`frontier-item ${
                  n.uid === snapshot.activeUid ? 'selected' : ''
                }`}
                onClick={() => onSetActive(n.uid)}
              >
                <span>node {n.uid}</span>
                <b>
                  {feasible}/{ann.length}
                </b>
              </button>
            );
          })}

          {unresolved.length === 0 && (
            <div className="empty">
              Tree complete. Export it or rewind a branch.
            </div>
          )}
        </div>
      </section>

      <section className="panel-section choice-panel">
        <div className="section-title">
          {expandedEntry
            ? `Thresholds for ${expandedEntry.name}`
            : `Choices for node ${active?.uid ?? '—'}`}
        </div>

        {budget && (
          <div className="budget-box">
            <div>
              <span>available here</span>
              <b>{formatObjective(graph, budget.nodeAvailableBudget)}</b>
            </div>
            <div>
              <span>best here</span>
              <b>{formatObjective(graph, budget.nodeBestObjective)}</b>
            </div>
            <div>
              <span>already committed</span>
              <b>{formatObjective(graph, budget.otherLowerBound)}</b>
            </div>
            <div>
              <span>feasible choices</span>
              <b>
                {feasibleTotal}/{activeChoices.length}
              </b>
            </div>
          </div>
        )}

        {!nativeOptionsReady && active?.kind === 'choice' && <div className="empty">Reading native options…</div>}
        {expandedEntry && (
          <button
            className="back-button"
            onClick={() => {
              setExpandedGroup(null);
              setQuery('');
            }}
          >
            ← Back to feature choices
          </button>
        )}

        <label className="search-box">
          <Search size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              expandedEntry
                ? 'Search thresholds'
                : 'Search features, thresholds, or descriptions'
            }
          />
        </label>

        <AnimatePresence mode="popLayout">
          {!expandedEntry && leaves.length > 0 && (
            <motion.div
              className="choice-group"
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="choice-group-title">
                Leaf options
                <span className="choice-group-count">
                  {leaves.length}/{totalLeaves} valid
                </span>
              </div>

              {leaves.map((x) =>
                x.choice.kind === 'leaf' ? (
                  <SplitButton
                    key={`l-${x.choice.leaf.id}`}
                    annotated={x}
                    graph={graph}
                    meta={meta}
                    thresholdDecimals={thresholdDecimals}
                    ui={ui}
                    onClick={() => { if (x.choice.kind === 'leaf') onApplyLeaf(x.choice.leaf.id); }}
                  />
                ) : null,
              )}
            </motion.div>
          )}

          {visibleGroupEntries.map((entry) => {
            if (entry.collapsed && !expandedEntry) {
              return (
                <motion.div
                  className="choice-group collapsed-choice-group"
                  layout
                  key={entry.name}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                >
                  {(() => {
                    const desc = continuousDescriptionForEntry(entry);

                    return (
                      <>
                        <button
                          className={`choice-group-title choice-group-title-row choice-group-title-button ${
                            desc?.open ? 'description-open' : ''
                          }`}
                          type="button"
                          onClick={() => {
                            if (!desc) return;
                            setOpenDescriptionKey((cur) => (cur === desc.key ? null : desc.key));
                          }}
                        >
                          <span>{entry.name}</span>
                          <span className="choice-group-count">
                            {entry.totalCount} choices
                          </span>
                        </button>

                        <AnimatePresence initial={false}>
                          {desc?.open && (
                            <motion.div
                              className="choice-group-description"
                              initial={{ opacity: 0, height: 0, y: -4 }}
                              animate={{ opacity: 1, height: 'auto', y: 0 }}
                              exit={{ opacity: 0, height: 0, y: -4 }}
                            >
                              {desc.text}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </>
                    );
                  })()}

                  <button
                    className="feature-summary-card"
                    onClick={() => {
                      setExpandedGroup(entry.name);
                      setQuery('');
                    }}
                  >
                    <div className="feature-summary-main">
                      <span>Choose threshold</span>
                      <b>{entry.validCount}/{entry.totalCount}</b>
                    </div>

                    <div className="feature-summary-sub">
                      best obj {formatObjective(graph, entry.bestObjective)}
                    </div>

                    <div className="feature-summary-hint">
                      View available thresholds →
                    </div>
                  </button>
                </motion.div>
              );
            }

            return (
              <motion.div
                className="choice-group"
                layout
                key={entry.name}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
              >
                {(() => {
                  const desc = continuousDescriptionForEntry(entry);

                  return (
                    <>
                      <button
                        className={`choice-group-title choice-group-title-row choice-group-title-button ${
                          desc?.open ? 'description-open' : ''
                        }`}
                        type="button"
                        onClick={() => {
                          if (!desc) return;
                          setOpenDescriptionKey((cur) => (cur === desc.key ? null : desc.key));
                        }}
                      >
                        <span>{entry.name}</span>
                        {expandedEntry && (
                          <span className="choice-group-count">
                            {entry.totalCount} choices
                          </span>
                        )}
                      </button>

                      <AnimatePresence initial={false}>
                        {desc?.open && (
                          <motion.div
                            className="choice-group-description"
                            initial={{ opacity: 0, height: 0, y: -4 }}
                            animate={{ opacity: 1, height: 'auto', y: 0 }}
                            exit={{ opacity: 0, height: 0, y: -4 }}
                          >
                            {desc.text}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </>
                  );
                })()}

                <div className="choice-grid">
                  {entry.choices.map((x) =>
                    x.choice.kind === 'split' ? (
                      <SplitButton
                        key={`s-${x.choice.split.id}`}
                        annotated={x}
                        graph={graph}
                        meta={meta}
                        thresholdDecimals={thresholdDecimals}
                        ui={ui}
                        onClick={() => { if (x.choice.kind === 'split') onApplySplit(x.choice.split.id); }}
                      />
                    ) : null,
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </section>
    </aside>
  );
}

function BuilderSettingsMenu({
  graph,
  meta,
  ui,
  setUi,
  thresholdDecimals,
  setThresholdDecimals,
}: {
  graph: AndOrGraph;
  meta: FeatureMeta & Record<string, unknown>;
  ui: BuilderUi;
  setUi: Dispatch<SetStateAction<BuilderUi>>;
  thresholdDecimals: number;
  setThresholdDecimals: Dispatch<SetStateAction<number>>;
}) {
  const [open, setOpen] = useState(false);

  const labels = useMemo(
    () =>
      Array.from(new Set(graph.leaf_nodes.map((leaf) => leaf.prediction))).sort(
        (a, b) => a - b,
      ),
    [graph],
  );

  const groups = useMemo(() => continuousGroupEntries(meta), [meta]);

  const binaryFeatures = useMemo(
    () => allSplitFeatures(graph).filter((feature) => isBinaryFeature(feature, meta)),
    [graph, meta],
  );

  const updateLabelName = (prediction: number, value: string) => {
    setUi((cur) => ({
      ...cur,
      labelNames: {
        ...cur.labelNames,
        [String(prediction)]: value,
      },
    }));
  };

  const updateGroupName = (group: string, value: string) => {
    setUi((cur) => ({
      ...cur,
      groupNames: { ...cur.groupNames, [group]: value },
    }));
  };

  const updateFeatureName = (feature: number, value: string) => {
    setUi((cur) => ({
      ...cur,
      featureNames: {
        ...cur.featureNames,
        [String(feature)]: value,
      },
    }));
  };

  const toggleBinaryFeatureParity = (feature: number) => {
    setUi((cur) => ({
      ...cur,
      binaryFeatureFlips: {
        ...cur.binaryFeatureFlips,
        [String(feature)]: !(cur.binaryFeatureFlips[String(feature)] ?? true),
      },
    }));
  };

  const updateColor = (
    key: Exclude<keyof BuilderColors, 'leafNodesByClass'>,
    value: string,
  ) => {
    setUi((cur) => ({
      ...cur,
      colors: {
        ...cur.colors,
        [key]: value,
      },
    }));
  };

  const updateLeafClassColor = (prediction: number, value: string) => {
    setUi((cur) => ({
      ...cur,
      colors: {
        ...cur.colors,
        leafNodesByClass: {
          ...cur.colors.leafNodesByClass,
          [String(prediction)]: value,
        },
      },
    }));
  };

  const resetNames = () => {
    setUi((cur) => ({
      ...cur,
      labelNames: {},
      featureNames: {},
      groupNames: {},
    }));
  };

  const resetParity = () => {
    setUi((cur) => ({
      ...cur,
      binaryFeatureFlips: {},
    }));
  };

  const resetColors = () => {
    setUi((cur) => ({
      ...cur,
      colors: {
        ...DEFAULT_COLORS,
        leafNodesByClass: {
          ...DEFAULT_COLORS.leafNodesByClass,
        },
      },
    }));
  };

  return (
    <div className="settings-wrap">
      <button className="ghost-button" onClick={() => setOpen((x) => !x)}>
        <SlidersHorizontal size={15} /> Customize
      </button>

      {open && (
        <div className="settings-popover">
          <div className="settings-header">
            <div>
              <b>Customize UI</b>
              <span>Names, binary parity, and colors only affect display.</span>
            </div>

            <button className="mini-button" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Feature display</div>

            <label className="settings-row">
              <span>Threshold Decimals</span>
              <input
                type="range"
                min={0}
                max={6}
                step={1}
                value={thresholdDecimals}
                onChange={(e) => setThresholdDecimals(Number(e.target.value))}
              />
            </label>

            <div className="settings-empty">
              Current: {thresholdDecimals}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Label names</div>

            {labels.map((prediction) => (
              <label className="settings-row" key={`label-${prediction}`}>
                <span>class {prediction}</span>
                <input
                  value={ui.labelNames[String(prediction)] ?? ''}
                  placeholder={`predict ${prediction}`}
                  onChange={(e) => updateLabelName(prediction, e.target.value)}
                />
              </label>
            ))}
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Continuous feature names</div>

            {groups.length === 0 && (
              <div className="settings-empty">No continuous groups in this payload.</div>
            )}

            {groups.map((group) => (
              <label className="settings-row" key={`group-${group.key}`}>
                <span>{group.key}</span>
                <input
                  value={ui.groupNames[group.key] ?? ''}
                  placeholder={group.key}
                  onChange={(e) => updateGroupName(group.key, e.target.value)}
                />
              </label>
            ))}
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Binary feature names</div>

            {binaryFeatures.length === 0 && (
              <div className="settings-empty">No binary features to show.</div>
            )}

            {binaryFeatures.map((feature) => {
              const flipped = binaryFeatureIsFlipped(feature, meta, ui);
              const naturalName = naturalBinaryFeatureName(feature, meta, ui);

              return (
                <div className="settings-row" key={`feature-${feature}`}>
                  <span title={naturalName}>{naturalName}</span>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) auto',
                      gap: 8,
                      alignItems: 'center',
                    }}
                  >
                    <input
                      value={ui.featureNames[String(feature)] ?? ''}
                      placeholder={naturalBinaryFeatureName(feature, meta, makeDefaultUi())}
                      onChange={(e) => updateFeatureName(feature, e.target.value)}
                    />
                    <button
                      type="button"
                      className="mini-button"
                      onClick={() => toggleBinaryFeatureParity(feature)}
                      title={
                        flipped
                          ? `Currently displaying ${naturalName} with natural true/false branches. Click to restore ${featureLabel(feature, meta)}.`
                          : `Currently displaying the raw threshold parity. Click to make ${naturalName} the natural true branch.`
                      }
                    >
                      {flipped ? 'Parity: flipped' : 'Parity: raw'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Colors</div>

            <label className="settings-row color-row">
              <span>split nodes</span>
              <input
                type="color"
                value={ui.colors.splitNode}
                onChange={(e) => updateColor('splitNode', e.target.value)}
              />
            </label>

            <label className="settings-row color-row">
              <span>leaves</span>
              <input
                type="color"
                value={ui.colors.leafNode}
                onChange={(e) => updateColor('leafNode', e.target.value)}
              />
            </label>

            {labels.map((prediction) => (
              <label className="settings-row color-row" key={`leaf-color-${prediction}`}>
                <span>{predictionLabel(prediction, ui)} leaf</span>
                <input
                  type="color"
                  value={
                    ui.colors.leafNodesByClass[String(prediction)] ||
                    ui.colors.leafNode
                  }
                  onChange={(e) => updateLeafClassColor(prediction, e.target.value)}
                />
              </label>
            ))}

            <label className="settings-row color-row">
              <span>edges</span>
              <input
                type="color"
                value={ui.colors.edge}
                onChange={(e) => updateColor('edge', e.target.value)}
              />
            </label>

            <label className="settings-row color-row">
              <span>background</span>
              <input
                type="color"
                value={ui.colors.background}
                onChange={(e) => updateColor('background', e.target.value)}
              />
            </label>
          </div>

          <div className="settings-actions">
            <button className="mini-button" onClick={resetNames}>
              Reset names
            </button>

            <button className="mini-button" onClick={resetParity}>
              Reset parity
            </button>

            <button className="mini-button" onClick={resetColors}>
              Reset colors
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FlowView({
  graph,
  meta,
  snapshot,
  thresholdDecimals,
  ui,
  setSnapshot,
  pushHistory,
}: {
  graph: AndOrGraph;
  meta: FeatureMeta & Record<string, unknown>;
  snapshot: HistorySnapshot;
  thresholdDecimals: number;
  ui: BuilderUi;
  setSnapshot: (s: HistorySnapshot) => void;
  pushHistory: () => void;
}) {
  const rf = useReactFlow();
  const container = useRef<HTMLDivElement>(null);
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});
  const measureNodes = (changes: NodeChange[]) => setNodeHeights(previous => {
    let next = previous;
    for (const change of changes) if (change.type === 'dimensions' && change.dimensions && previous[change.id] !== change.dimensions.height) {
      if (next === previous) next = { ...previous };
      next[change.id] = change.dimensions.height;
    }
    return next;
  });

  const { nodes: laidNodes, edges: laidEdges } = useMemo(
    () => layoutTree(displayTreeForUi(snapshot.root, meta, ui), nodeHeights),
    [snapshot.root, meta, ui.binaryFeatureFlips, nodeHeights],
  );

  const nodes: Node<NodeData>[] = useMemo(
    () =>
      laidNodes.map((n) => {
        const ann =
          n.kind === 'choice' ? annotateChoicesFor(graph, snapshot, n.uid) : [];

        return {
          id: String(n.uid),
          type: 'arborenum',
          position: { x: n.x, y: n.y },
          data: {
            b: n,
            active: n.uid === snapshot.activeUid,
            choices:
              n.kind === 'choice' ? choicesFor(graph, n.graphTrieId).length : 0,
            feasibleChoices: ann.filter((x) => x.feasible).length,
            meta,
            graph,
            thresholdDecimals,
            ui,
          },
          draggable: false,
        };
      }),
    [laidNodes, snapshot, graph, meta, thresholdDecimals, ui],
  );

  const edges: Edge[] = useMemo(
    () =>
      laidEdges.map((e) => ({
        id: e.id,
        source: String(e.source),
        target: String(e.target),
        label: e.label,
        type: 'straight',
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed, color: ui.colors.edge },
        labelBgPadding: [9, 5] as [number, number],
        labelBgBorderRadius: 999,
        style: {
          strokeWidth: 2,
          stroke: ui.colors.edge,
        },
        labelStyle: {
          fontWeight: 650,
          fontSize: 14,
        },
      })),
    [laidEdges, ui.colors.edge],
  );

  useEffect(() => {
    let timer: number;
    const fit = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        rf.fitView({ padding: 0.22, duration: 450, maxZoom: 1.15 });
      }, 40);
    };
    const observer = new ResizeObserver(fit);
    if (container.current) observer.observe(container.current);
    fit();
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [nodes.length, nodeHeights, rf]);

  return (
    <div className="flow-stage" ref={container}>
    <ReactFlow
      nodes={nodes}
      onNodesChange={measureNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodeOrigin={[0.5, 0]}
      minZoom={0.12}
      maxZoom={2.2}
      fitView
      fitViewOptions={{ padding: 0.22, maxZoom: 1.15 }}
      onNodeClick={(_, node) => {
        const b = (node.data as NodeData).b;

        if (b.kind === 'choice') {
          setSnapshot({ ...snapshot, activeUid: b.uid });
        } else {
          pushHistory();
          setSnapshot(rewind(snapshot, b.uid));
        }
      }}
    >
      <Controls fitViewOptions={{ padding: 0.22, maxZoom: 1.15 }} />
    </ReactFlow>
    </div>
  );
}

function App() {
  const initialPayload = window.ARBORENUM_BUILDER_PAYLOAD;

  const initialGraph =
    window.ARBORENUM_ANDOR_GRAPH ??
    initialPayload?.graph ??
    sampleGraph;

  const initialMeta = coerceMeta(initialPayload);

  const [graph, setGraph] = useState<AndOrGraph>(initialGraph);
  const [meta, setMeta] = useState<FeatureMeta & Record<string, unknown>>(initialMeta);
  const [graphGeneration, setGraphGeneration] = useState(0);
  const [payloadName, setPayloadName] = useState<string>('Example workspace');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [thresholdDecimals, setThresholdDecimals] = useState(3);
  const [ui, setUi] = useState<BuilderUi>(() => makeDefaultUi());

  const [snapshot, setSnapshot] = useState<HistorySnapshot>(() =>
    autoExpandSingletons(makeRoot(initialGraph), initialGraph),
  );
  const [history, setHistory] = useState<HistorySnapshot[]>([]);

  const liveSession = useRef('');
  const nativeAdapter = useRef(new NativeGraphAdapter());
  const [nativeReady, setNativeReady] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeRefresh, setNativeRefresh] = useState(0);
  const [datasetPending, setDatasetPending] = useState(false);
  const [enumerationOpen, setEnumerationOpen] = useState(false);
  const [liveAvailable, setLiveAvailable] = useState(false);
  const nativeRequest = useRef(0);
  const nativeSelection = useRef(snapshot); nativeSelection.current = snapshot;
  const nativeQueriedSelection = useRef<HistorySnapshot | null>(null);
  const nativeQueriedRefresh = useRef(0);
  const active = findNode(snapshot.root, snapshot.activeUid);

  const loadPayload = (raw: unknown, name: string) => {
    const payload = raw as Window['ARBORENUM_BUILDER_PAYLOAD'];

    const nextGraph = payload?.graph;

    if (!nextGraph) {
      throw new Error('Payload must contain a top-level "graph" field.');
    }

    const nextMeta = coerceMeta(payload);
    liveSession.current = '';
    setDatasetPending(false);
    setNativeReady(false); setNativeBusy(false);
    ++nativeRequest.current;

    setGraph(nextGraph);
    setGraphGeneration(value => value + 1);
    setMeta(nextMeta);
    setSnapshot(autoExpandSingletons(makeRoot(nextGraph), nextGraph));
    setHistory([]);
    setPayloadName(name);
    setUploadError(null);
    setUi(makeDefaultUi());
  };

  const prepareNative = () => {
    liveSession.current = '';
    nativeAdapter.current = new NativeGraphAdapter();
    nativeQueriedSelection.current = null;
    ++nativeRequest.current;
    setNativeReady(false); setNativeBusy(false);
    setDatasetPending(true);
    const empty: AndOrGraph = { root_trie_id: 0, trie_nodes: [], split_nodes: [], leaf_nodes: [], metadata: { native: true } };
    setGraph(empty); setMeta({}); setSnapshot(makeRoot(empty)); setHistory([]);
    setGraphGeneration(value => value + 1);
    setUi(makeDefaultUi()); setUploadError(null);
    rememberCurrentPayload({ graph: empty, meta: {} });
    delete window.ARBORENUM_NATIVE_CONSTRAINED_COMPLETION;
  };
  const connectNative = (id: string) => {
    prepareNative();
    liveSession.current = id;
  };
  const readyNative = (id: string, nativeMeta: ArborEnumBuilderMeta) => {
    if (id !== liveSession.current) return;
    const empty: AndOrGraph = { root_trie_id: 0, trie_nodes: [{ id: 0, budget: 0, min_objective: 0, subproblem_size: Number(nativeMeta.root_n), leaf_ids: [], split_ids: [] }], split_nodes: [], leaf_nodes: [], metadata: { native: true } };
    const payload = normalizeArborEnumPayload({ graph: empty, meta: nativeMeta });
    setGraph(empty); setMeta(payload.meta);
    setSnapshot(makeRoot(empty)); setHistory([]);
    setGraphGeneration(value => value + 1);
    const classNames = nativeMeta.classNames;
    setUi({ ...makeDefaultUi(), labelNames: Array.isArray(classNames) ? Object.fromEntries(classNames.map((name, i) => [String(i), String(name)])) : {} });
    setNativeReady(true); setUploadError(null);
  };

  useEffect(() => {
    if (!nativeReady || (nativeQueriedSelection.current === snapshot && nativeQueriedRefresh.current === nativeRefresh)) return;
    const session = liveSession.current;
    const sequence = ++nativeRequest.current;
    const controller = new AbortController();
    setNativeBusy(true);
    void nativeApi<NativeNodeView>('node', session, { tree: snapshot.root, active_uid: snapshot.activeUid }, controller.signal).then(response => {
      if (sequence !== nativeRequest.current || session !== liveSession.current || nativeSelection.current !== snapshot) return;
      const fragment = nativeAdapter.current.view(snapshot, response);
      setGraph(fragment);
      setDatasetPending(false);
      nativeQueriedSelection.current = snapshot;
      nativeQueriedRefresh.current = nativeRefresh;
      rememberCurrentPayload({ graph: fragment, meta });
      setPayloadName(`native ArborEnum · query ${response.query_id}`);
      setUploadError(null);
    }).catch(error => {
      if (!controller.signal.aborted && sequence === nativeRequest.current) setUploadError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (sequence === nativeRequest.current) setNativeBusy(false); });
    return () => controller.abort();
  }, [snapshot, nativeReady, nativeRefresh]);

  const completeNative = async (mode: 'optimal' | 'random' | 'constrained', constraint?: NativeConstraint) => {
    if (!nativeReady || nativeBusy) return { ok: false, message: 'Wait for the current native query to finish.' };
    const selected = snapshot, session = liveSession.current;
    const sequence = ++nativeRequest.current;
    setNativeBusy(true);
    try {
      const result = await nativeApi<NativeCompletion>('complete', session, { tree: selected.root, active_uid: selected.activeUid, next_uid: selected.nextUid, mode, constraint: constraint ?? {}, seed: Math.floor(Math.random() * 0xffffffff) });
      if (sequence !== nativeRequest.current || session !== liveSession.current || nativeSelection.current !== selected) return { ok: false, message: 'Selection changed; request completion again.' };
      const next = nativeAdapter.current.normalize({ root: result.tree, activeUid: result.active_uid, nextUid: result.next_uid });
      const fragment = nativeAdapter.current.view(next, result.view);
      setGraph(fragment);
      nativeQueriedSelection.current = next;
      nativeQueriedRefresh.current = nativeRefresh;
      rememberCurrentPayload({ graph: fragment, meta });
      setPayloadName(`native ArborEnum · query ${result.view.query_id}`);
      setHistory(previous => [...previous, cloneSnapshot(selected)]);
      setSnapshot(next);
      setUploadError(null);
      return { ok: true, message: 'Native completion applied.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sequence === nativeRequest.current) setUploadError(message);
      return { ok: false, message };
    } finally { if (sequence === nativeRequest.current) setNativeBusy(false); }
  };
  useEffect(() => {
    if (!nativeReady) return;
    const handler = (constraint: NativeConstraint) => completeNative('constrained', constraint);
    window.ARBORENUM_NATIVE_CONSTRAINED_COMPLETION = handler;
    return () => { if (window.ARBORENUM_NATIVE_CONSTRAINED_COMPLETION === handler) delete window.ARBORENUM_NATIVE_CONSTRAINED_COMPLETION; };
  }, [nativeReady, snapshot, nativeBusy]);

  const pushHistory = () => {
    setHistory((h) => [...h, cloneSnapshot(snapshot)]);
  };
  const setWithHistory = (next: HistorySnapshot) => {
    if (next === snapshot) return;

    pushHistory();
    setSnapshot(next);
  };

  const themeStyle = {
    '--builder-bg': ui.colors.background,
    '--split-node-bg': ui.colors.splitNode,
    '--leaf-node-bg': ui.colors.leafNode,
    '--edge-color': ui.colors.edge,
  } as CSSProperties;

  return (
    <div className="app-shell" style={themeStyle}>
      <header className="canvas-header">
          <div>
            <div className="workspace-brand"><span className="workspace-mark"><Network size={22} /></span><div><div className="workspace-eyebrow">ANYTIME TREE BUILDER</div><h1>Your tree. Every possibility.</h1></div></div>
            <p className="payload-name">{datasetPending ? 'Waiting for a new dataset tree…' : payloadName.startsWith('native ArborEnum') ? 'Live enumeration workspace' : `Loaded ${payloadName}`}</p>
            <LiveEnumerationPanel
              open={enumerationOpen}
              onClose={() => setEnumerationOpen(false)}
              onAvailable={setLiveAvailable}
              onConnect={connectNative}
              onPrepare={prepareNative}
              onReady={readyNative}
              onRefresh={() => setNativeRefresh(value => value + 1)}
              querying={nativeBusy}
              canRefresh={nativeReady}
            />
            {nativeBusy && <p className="native-query-status" role="status">Reading options from the native graph…</p>}
            {uploadError && <p className="upload-error">{uploadError}</p>}
          </div>

          <div className="header-actions">
            {!datasetPending && <BuilderSettingsMenu
              graph={graph}
              meta={meta}
              ui={ui}
              setUi={setUi}
              thresholdDecimals={thresholdDecimals}
              setThresholdDecimals={setThresholdDecimals}
            />}

            <UploadMenu liveAvailable={liveAvailable} onDataset={() => setEnumerationOpen(true)} onGraph={async file => {
              try { loadPayload(await readJsonFile(file), file.name); }
              catch (error) { setUploadError(error instanceof Error ? error.message : 'Could not load graph JSON.'); }
            }} />

            <div className={`status ${!datasetPending && isComplete(snapshot.root) ? 'done' : ''}`}>
              {datasetPending ? 'waiting' : isComplete(snapshot.root) ? 'complete' : 'building'}
            </div>
          </div>
      </header>

      <div className="canvas-card">
        <div className="canvas-context"><span><Network size={14} /> DECISION CANVAS</span><span>{datasetPending ? 'Awaiting your first tree' : 'Select a node to explore'}<ChevronRight size={13} /></span></div>
        {datasetPending ? <div className="flow-wrap dataset-waiting" role="status"><Network size={38} strokeWidth={1} /><h2>Waiting for your first tree</h2><p>Your new tree will appear here as soon as its first completion is ready.</p></div> : <ReactFlowProvider key={graphGeneration}>
          <div className="flow-wrap">
            <FlowView
              graph={graph}
              meta={meta}
              snapshot={snapshot}
              thresholdDecimals={thresholdDecimals}
              ui={ui}
              setSnapshot={setSnapshot}
              pushHistory={pushHistory}
            />
          </div>
        </ReactFlowProvider>}
      </div>

      {datasetPending ? <aside className="panel dataset-waiting" aria-label="Waiting for dataset options"><CircleDot size={28} strokeWidth={1} /><h3>A fresh start</h3><p>Your split options and objective budget will appear with the new tree.</p></aside> : <SidePanel
        graph={graph}
        meta={meta}
        snapshot={snapshot}
        active={active}
        thresholdDecimals={thresholdDecimals}
        ui={ui}
        canUndo={history.length > 0}
        onUndo={() => {
          const last = history[history.length - 1];
          if (!last) return;

          setHistory((h) => h.slice(0, -1));
          setSnapshot(last);
        }}
        onReset={() => {
          pushHistory();
          setSnapshot(autoExpandSingletons(makeRoot(graph), graph));
        }}
        onRandom={() => {
          if (liveSession.current) { void completeNative('random'); return; }
          setWithHistory(randomComplete(snapshot, graph));
        }}
        onOptimal={() => {
          if (liveSession.current) { void completeNative('optimal'); return; }
          setWithHistory(optimalComplete(snapshot, graph));
        }}
        onSetActive={(uid) => setSnapshot({ ...snapshot, activeUid: uid })}
        onApplyLeaf={(leafId) => {
          if (!active || (liveSession.current && (nativeBusy || nativeQueriedSelection.current !== snapshot))) return;
          setWithHistory(applyLeaf(snapshot, graph, active.uid, leafId));
        }}
        onApplySplit={(splitId) => {
          if (!active || (liveSession.current && (nativeBusy || nativeQueriedSelection.current !== snapshot))) return;
          setWithHistory(applySplit(snapshot, graph, active.uid, splitId));
        }}
      />}
    </div>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Missing #root element.');
}

createRoot(rootElement).render(<App />);
