const STYLE_ID = 'arborenum-favorites-style';
const HEADER_ROW_ID = 'arborenum-header-tree-actions';
const COMPLETION_LABEL_ID = 'arborenum-completion-label';
const OVERLAY_ID = 'arborenum-starred-trees-overlay';
const TOAST_ID = 'arborenum-favorites-toast';

type BuildNodeLike = {
  uid: number;
  graphTrieId: number;
  kind: 'choice' | 'split' | 'leaf';
  feature?: number;
  left?: BuildNodeLike;
  right?: BuildNodeLike;
};

type SnapshotLike = {
  root: BuildNodeLike;
  activeUid: number;
  nextUid: number;
};

type RegistryEntry = {
  internalFeature: number;
  originalName: string;
  threshold: number;
};

type CurrentPayload = {
  meta?: Record<string, unknown> & {
    featureRegistry?: RegistryEntry[];
    featureNames?: string[];
  };
};

type HookLike = {
  memoizedState: unknown;
  next?: HookLike | null;
  queue?: { dispatch?: (value: unknown) => void } | null;
};

type FiberLike = {
  child?: FiberLike | null;
  sibling?: FiberLike | null;
  alternate?: FiberLike | null;
  memoizedState?: HookLike | unknown;
};

type SnapshotBridge = {
  snapshot: SnapshotLike;
  snapshotHook: HookLike;
  historyHook?: HookLike;
};

type FavoriteTree = {
  id: number;
  label: string;
  snapshot: SnapshotLike;
  signature: string;
  savedAt: number;
  splitRules: string[];
  accuracy?: string;
};

type TreeCounts = {
  total: number;
  splits: number;
  leaves: number;
  open: number;
  depth: number;
};

type ThumbPoint = {
  node: BuildNodeLike;
  x: number;
  depth: number;
};

let favorites: FavoriteTree[] = [];
let nextFavoriteId = 1;
let galleryOpen = false;
let exportMode = false;
let selectedForExport = new Set<number>();
let toastTimer: number | undefined;
let syncScheduled = false;

function cloneSnapshot(snapshot: SnapshotLike): SnapshotLike {
  return JSON.parse(JSON.stringify(snapshot)) as SnapshotLike;
}

function isSnapshot(value: unknown): value is SnapshotLike {
  if (!value || typeof value !== 'object') return false;
  const x = value as Partial<SnapshotLike>;
  return (
    !!x.root &&
    typeof x.root === 'object' &&
    Number.isInteger(x.activeUid) &&
    Number.isInteger(x.nextUid)
  );
}

function currentPayload(): CurrentPayload | undefined {
  const w = window as unknown as Window & Record<string, unknown>;
  return (
    w.ARBORENUM_CURRENT_BUILDER_PAYLOAD ??
    w.ARBORENUM_BUILDER_PAYLOAD
  ) as CurrentPayload | undefined;
}

function registry(): RegistryEntry[] {
  const raw = currentPayload()?.meta?.featureRegistry;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => ({
      internalFeature: Number(entry.internalFeature),
      originalName: String(entry.originalName),
      threshold: Number(entry.threshold),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.internalFeature) &&
        entry.originalName.length > 0 &&
        Number.isFinite(entry.threshold),
    );
}

function formatThreshold(value: number): string {
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function fallbackSplitRule(feature: number | undefined): string {
  if (feature === undefined) return 'split';

  const entry = registry().find((x) => x.internalFeature === feature);
  if (entry) return `${entry.originalName} ≤ ${formatThreshold(entry.threshold)}`;

  const names = currentPayload()?.meta?.featureNames;
  const name = Array.isArray(names) ? names[feature] : undefined;
  return name ? String(name) : `feature ${feature}`;
}

function splitRulesFromSnapshot(snapshot: SnapshotLike): string[] {
  const rules: string[] = [];

  const walk = (node?: BuildNodeLike) => {
    if (!node) return;
    if (node.kind === 'split') {
      const domTitle = document
        .querySelector<HTMLElement>(
          `.react-flow__node-arborenum[data-id="${node.uid}"] .node-title`,
        )
        ?.textContent?.trim();
      rules.push(domTitle || fallbackSplitRule(node.feature));
    }
    walk(node.left);
    walk(node.right);
  };

  walk(snapshot.root);
  return rules;
}

function nodeCounts(root: BuildNodeLike): TreeCounts {
  let total = 0;
  let splits = 0;
  let leaves = 0;
  let open = 0;
  let depth = 0;

  const walk = (node: BuildNodeLike | undefined, d: number) => {
    if (!node) return;
    total += 1;
    depth = Math.max(depth, d);
    if (node.kind === 'split') splits += 1;
    else if (node.kind === 'leaf') leaves += 1;
    else open += 1;
    walk(node.left, d + 1);
    walk(node.right, d + 1);
  };

  walk(root, 0);
  return { total, splits, leaves, open, depth };
}

function treeSignature(snapshot: SnapshotLike): string {
  const encode = (node?: BuildNodeLike): unknown => {
    if (!node) return null;
    return {
      graphTrieId: node.graphTrieId,
      kind: node.kind,
      left: encode(node.left),
      right: encode(node.right),
    };
  };
  return JSON.stringify(encode(snapshot.root));
}

function rootFiber(): FiberLike | undefined {
  const root = document.getElementById('root') as
    | (HTMLElement & Record<string, unknown>)
    | null;
  if (!root) return undefined;

  const key = Object.keys(root).find((x) => x.startsWith('__reactContainer$'));
  return key ? (root[key] as FiberLike | undefined) : undefined;
}

function activeUidFromDom(): number | undefined {
  const active = document.querySelector(
    '.react-flow__node-arborenum .arborenum-node.active',
  );
  const flowNode = active?.closest<HTMLElement>('.react-flow__node-arborenum');
  const uid = Number(flowNode?.dataset.id ?? flowNode?.getAttribute('data-id'));
  return Number.isInteger(uid) ? uid : undefined;
}

function findSnapshotHooks(start?: FiberLike): SnapshotBridge[] {
  if (!start) return [];

  const out: SnapshotBridge[] = [];
  const seen = new Set<FiberLike>();
  const stack: FiberLike[] = [start];

  while (stack.length > 0) {
    const fiber = stack.pop()!;
    if (seen.has(fiber)) continue;
    seen.add(fiber);

    const state = fiber.memoizedState;
    if (state && typeof state === 'object' && 'memoizedState' in state) {
      let hook = state as HookLike;
      while (hook) {
        if (isSnapshot(hook.memoizedState) && typeof hook.queue?.dispatch === 'function') {
          const historyHook =
            hook.next &&
            Array.isArray(hook.next.memoizedState) &&
            typeof hook.next.queue?.dispatch === 'function'
              ? hook.next
              : undefined;
          out.push({ snapshot: hook.memoizedState, snapshotHook: hook, historyHook });
        }
        hook = hook.next ?? (undefined as unknown as HookLike);
      }
    }

    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.alternate) stack.push(fiber.alternate);
  }

  return out;
}

function currentBridge(): SnapshotBridge | undefined {
  const candidates = findSnapshotHooks(rootFiber());
  if (candidates.length === 0) return undefined;

  const activeUid = activeUidFromDom();
  const renderedNodes = document.querySelectorAll('.react-flow__node-arborenum').length;

  return (
    candidates.find((candidate) => {
      const counts = nodeCounts(candidate.snapshot.root);
      return candidate.snapshot.activeUid === activeUid && counts.total === renderedNodes;
    }) ??
    candidates.find((candidate) => nodeCounts(candidate.snapshot.root).total === renderedNodes) ??
    candidates[0]
  );
}

function currentSignature(): string | undefined {
  const bridge = currentBridge();
  return bridge ? treeSignature(bridge.snapshot) : undefined;
}

function currentIsFavorite(): boolean {
  const signature = currentSignature();
  return !!signature && favorites.some((tree) => tree.signature === signature);
}

function completedAccuracyFromDom(): string | undefined {
  const sections = Array.from(document.querySelectorAll<HTMLElement>('.panel-section'));
  const completed = sections.find(
    (section) =>
      section.querySelector('.section-title')?.textContent?.trim().toLowerCase() ===
      'completed tree',
  );
  if (!completed) return undefined;

  for (const row of completed.querySelectorAll<HTMLElement>('.budget-box > div')) {
    if (row.querySelector('span')?.textContent?.trim().toLowerCase() === 'accuracy') {
      return row.querySelector('b')?.textContent?.trim() || undefined;
    }
  }
  return undefined;
}

function afterReactPaint(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

function showToast(message: string) {
  document.getElementById(TOAST_ID)?.remove();
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.className = 'favorites-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('show');
    window.setTimeout(() => toast.remove(), 180);
  }, 1050);
}

function restoreFavorite(tree: FavoriteTree) {
  const bridge = currentBridge();
  if (!bridge || typeof bridge.snapshotHook.queue?.dispatch !== 'function') return;

  const current = cloneSnapshot(bridge.snapshot);
  if (bridge.historyHook && typeof bridge.historyHook.queue?.dispatch === 'function') {
    bridge.historyHook.queue.dispatch((previous: unknown) =>
      Array.isArray(previous) ? [...previous, current] : [current],
    );
  }

  bridge.snapshotHook.queue.dispatch(cloneSnapshot(tree.snapshot));
  closeGallery();
  afterReactPaint(syncAllControls);
}

function starCurrentTree() {
  const bridge = currentBridge();
  if (!bridge) return;

  const snapshot = cloneSnapshot(bridge.snapshot);
  const signature = treeSignature(snapshot);
  const existing = favorites.find((tree) => tree.signature === signature);

  if (existing) {
    showToast('Already in Favorites');
    updateHeaderState();
    return;
  }

  const counts = nodeCounts(snapshot.root);
  favorites.push({
    id: nextFavoriteId,
    label: `Tree ${nextFavoriteId}`,
    snapshot,
    signature,
    savedAt: Date.now(),
    splitRules: splitRulesFromSnapshot(snapshot),
    accuracy: counts.open === 0 ? completedAccuracyFromDom() : undefined,
  });
  nextFavoriteId += 1;

  showToast('★ Saved to Favorites');
  updateHeaderState();
}

function removeFavorite(id: number) {
  favorites = favorites.filter((tree) => tree.id !== id);
  selectedForExport.delete(id);
  updateHeaderState();
  renderGallery();
}

function renameFavorite(id: number, label: string) {
  const tree = favorites.find((x) => x.id === id);
  if (tree) tree.label = label.slice(0, 60);
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportSelectedFavorites() {
  const chosen = favorites.filter((tree) => selectedForExport.has(tree.id));
  if (chosen.length === 0) return;

  const exported = chosen.map((tree) => {
    const counts = nodeCounts(tree.snapshot.root);
    const complete = counts.open === 0;
    return {
      name: tree.label,
      saved_at: new Date(tree.savedAt).toISOString(),
      complete,
      ...(complete
        ? {
            accuracy: tree.accuracy ?? null,
            leaves: counts.leaves,
          }
        : { status: 'partial' }),
      split_rules: tree.splitRules,
      snapshot: tree.snapshot,
    };
  });

  const date = new Date().toISOString().slice(0, 10);
  downloadJson(`arborenum-favorites-${date}.json`, {
    format: 'arborenum-favorites',
    version: 1,
    exported_at: new Date().toISOString(),
    count: exported.length,
    favorites: exported,
  });

  showToast(`Exported ${exported.length} favorite${exported.length === 1 ? '' : 's'}`);
}

function formatSavedTime(time: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(time));
  } catch {
    return '';
  }
}

function thumbnailLayout(root: BuildNodeLike): {
  points: ThumbPoint[];
  edges: Array<[ThumbPoint, ThumbPoint]>;
  maxX: number;
  maxDepth: number;
} {
  const points: ThumbPoint[] = [];
  const edges: Array<[ThumbPoint, ThumbPoint]> = [];
  let leafX = 0;
  let maxDepth = 0;

  const visit = (node: BuildNodeLike, depth: number): ThumbPoint => {
    maxDepth = Math.max(maxDepth, depth);
    const children = [node.left, node.right].filter(
      (x): x is BuildNodeLike => !!x,
    );

    if (children.length === 0) {
      const point = { node, x: leafX++, depth };
      points.push(point);
      return point;
    }

    const childPoints = children.map((child) => visit(child, depth + 1));
    const point = {
      node,
      x: childPoints.reduce((sum, p) => sum + p.x, 0) / childPoints.length,
      depth,
    };
    points.push(point);
    childPoints.forEach((child) => edges.push([point, child]));
    return point;
  };

  visit(root, 0);
  return {
    points,
    edges,
    maxX: Math.max(1, leafX - 1),
    maxDepth: Math.max(1, maxDepth),
  };
}

function makeTreeThumbnail(tree: FavoriteTree): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 220 104');
  svg.setAttribute('class', 'starred-tree-thumbnail');
  svg.setAttribute('aria-hidden', 'true');

  const layout = thumbnailLayout(tree.snapshot.root);
  const px = (x: number) => 18 + (184 * x) / layout.maxX;
  const py = (depth: number) => 14 + (76 * depth) / layout.maxDepth;

  for (const [from, to] of layout.edges) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(px(from.x)));
    line.setAttribute('y1', String(py(from.depth)));
    line.setAttribute('x2', String(px(to.x)));
    line.setAttribute('y2', String(py(to.depth)));
    line.setAttribute('class', 'starred-thumb-edge');
    svg.appendChild(line);
  }

  for (const point of layout.points) {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', String(px(point.x)));
    circle.setAttribute('cy', String(py(point.depth)));
    circle.setAttribute('r', point.node.kind === 'split' ? '4.6' : '4.1');
    circle.setAttribute('class', `starred-thumb-node starred-thumb-${point.node.kind}`);
    svg.appendChild(circle);
  }

  return svg;
}

function findToolbarButton(prefix: string): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('.toolbar-row .ghost-button'),
  ).find((button) => button.textContent?.trim().toLowerCase().startsWith(prefix));
}

function organizeControls() {
  const toolbar = document.querySelector('.toolbar-row');
  if (!toolbar) return;

  const undo = findToolbarButton('undo');
  const reset = findToolbarButton('reset');
  const random = findToolbarButton('random');
  const optimal = findToolbarButton('optimal');
  const exportButton = findToolbarButton('export');
  const constrained = document.getElementById(
    'arborenum-constrained-completion-button',
  ) as HTMLButtonElement | null;

  undo?.classList.add('arborenum-hidden-control');
  reset?.classList.add('arborenum-hidden-control');
  exportButton?.classList.add('arborenum-hidden-control', 'arborenum-original-export');

  random?.classList.add('arborenum-completion-random');
  optimal?.classList.add('arborenum-completion-optimal');
  constrained?.classList.add('arborenum-completion-constrained');

  let label = document.getElementById(COMPLETION_LABEL_ID);
  if (!label) {
    label = document.createElement('div');
    label.id = COMPLETION_LABEL_ID;
    label.className = 'arborenum-completion-label';
    label.innerHTML = '<b>Complete tree</b><span>Fill every unfinished node</span>';
    toolbar.prepend(label);
  }
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .arborenum-hidden-control { display: none !important; }

    .header-actions {
      display: grid !important;
      grid-template-columns: auto auto auto;
      align-items: center;
      justify-content: end;
      gap: 7px 9px !important;
    }

    #${HEADER_ROW_ID} {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 7px;
    }

    #${HEADER_ROW_ID} .ghost-button {
      min-width: 104px;
      white-space: nowrap;
    }

    .favorite-star-active {
      border-color: #e3bd4c !important;
      background: #fffaf0 !important;
      color: #7a5200 !important;
    }

    .starred-tree-count {
      min-width: 17px;
      height: 17px;
      padding: 0 5px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #fff4cf;
      color: #8b5d00;
      font-size: 9px;
      font-weight: 900;
      line-height: 1;
    }

    .toolbar-row { grid-template-columns: repeat(3, 1fr) !important; }

    .arborenum-completion-label {
      grid-column: 1 / -1;
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 1px 2px 2px;
      order: 0;
    }

    .arborenum-completion-label b {
      color: #334155;
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .arborenum-completion-label span {
      color: #94a3b8;
      font-size: 9px;
      font-weight: 750;
    }

    .arborenum-completion-optimal { order: 1; }
    .arborenum-completion-random { order: 2; }
    .arborenum-completion-constrained { order: 3; }

    .favorites-toast {
      position: fixed;
      z-index: 12000;
      top: 24px;
      left: 50%;
      transform: translate(-50%, -8px);
      padding: 10px 15px;
      border: 1px solid #d8e3ed;
      border-radius: 11px;
      background: rgba(255,255,255,0.97);
      color: #334155;
      box-shadow: 0 12px 34px rgba(15,23,42,0.17);
      font-size: 13px;
      font-weight: 850;
      opacity: 0;
      pointer-events: none;
      transition: opacity .16s ease, transform .16s ease;
    }

    .favorites-toast.show {
      opacity: 1;
      transform: translate(-50%, 0);
    }

    .starred-overlay {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px;
      background: rgba(15, 23, 42, 0.34);
      backdrop-filter: blur(4px);
    }

    .starred-gallery {
      width: min(1040px, calc(100vw - 56px));
      max-height: min(800px, calc(100vh - 56px));
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid #d7e1eb;
      border-radius: 18px;
      background: #ffffff;
      box-shadow: 0 28px 90px rgba(15, 23, 42, 0.28);
    }

    .starred-gallery-head {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 20px 16px;
      border-bottom: 1px solid #e8eef5;
    }

    .starred-gallery-head-copy { display: grid; gap: 4px; }
    .starred-gallery-head-copy b { color: #17263a; font-size: 18px; }
    .starred-gallery-head-copy span { color: #66788d; font-size: 11px; line-height: 1.4; }

    .starred-gallery-head-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .starred-gallery-export,
    .starred-gallery-close,
    .starred-export-action,
    .starred-export-cancel {
      min-height: 34px;
      border: 1px solid #dbe4ee;
      border-radius: 10px;
      background: #f7f9fc;
      color: #40546a;
      cursor: pointer;
      padding: 0 11px;
      font-size: 11px;
      font-weight: 850;
    }

    .starred-gallery-close {
      width: 34px;
      padding: 0;
      color: #607086;
      font-size: 20px;
      line-height: 1;
    }

    .starred-export-toolbar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 20px;
      border-bottom: 1px solid #e8eef5;
      background: #fffdf7;
    }

    .starred-export-select-all {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: #475569;
      font-size: 12px;
      font-weight: 800;
    }

    .starred-export-count {
      margin-right: auto;
      color: #64748b;
      font-size: 12px;
      font-weight: 750;
    }

    .starred-export-action {
      border-color: #82afd0;
      background: #eef7fd;
      color: #075f93;
    }

    .starred-export-action:disabled {
      opacity: .45;
      cursor: not-allowed;
    }

    .starred-gallery-grid {
      flex: 1 1 auto;
      min-height: 0;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      align-content: start;
      gap: 14px;
      overflow-y: auto;
      padding: 18px 20px 22px;
      background: #f7f9fc;
      scrollbar-gutter: stable;
    }

    .starred-gallery-empty {
      grid-column: 1 / -1;
      min-height: 290px;
      display: grid;
      place-items: center;
      padding: 30px;
      border: 1px dashed #bfd0df;
      border-radius: 15px;
      background: #ffffff;
      color: #8a9bae;
      text-align: center;
      font-size: 12px;
      line-height: 1.55;
    }

    .starred-tree-card {
      position: relative;
      min-width: 0;
      overflow: hidden;
      border: 1px solid #d8e3ed;
      border-radius: 15px;
      background: #ffffff;
      box-shadow: 0 3px 10px rgba(15, 23, 42, 0.04);
      transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
    }

    .starred-tree-card:hover {
      transform: translateY(-3px);
      border-color: #dfb43d;
      box-shadow: 0 14px 32px rgba(15, 23, 42, 0.13);
    }

    .starred-tree-card.current {
      border-color: #5c9dcc;
      box-shadow: 0 0 0 2px rgba(0,114,178,.10), 0 9px 25px rgba(15,23,42,.08);
    }

    .starred-tree-card.export-selected {
      border-color: #d7aa2d;
      box-shadow: 0 0 0 2px rgba(215,170,45,.14), 0 9px 25px rgba(15,23,42,.08);
    }

    .starred-tree-select {
      position: absolute;
      z-index: 3;
      top: 10px;
      right: 10px;
      width: 20px;
      height: 20px;
      accent-color: #b78300;
    }

    .starred-tree-visual {
      position: relative;
      height: 116px;
      display: grid;
      place-items: center;
      overflow: hidden;
      border-bottom: 1px solid #eaf0f5;
      background: linear-gradient(180deg,#f5f9fc 0%,#fff 100%);
    }

    .starred-tree-thumbnail { width: 94%; height: 100px; overflow: visible; }
    .starred-thumb-edge { stroke: #9fb3c7; stroke-width: 2.3; stroke-linecap: round; }
    .starred-thumb-node { stroke: #fff; stroke-width: 1.6; }
    .starred-thumb-split { fill: #4f8bb8; }
    .starred-thumb-leaf { fill: #67a77d; }
    .starred-thumb-choice { fill: #d49a26; }

    .starred-tree-number,
    .starred-tree-current-badge {
      position: absolute;
      top: 9px;
      padding: 4px 7px;
      border-radius: 999px;
      font-size: 8px;
      font-weight: 900;
    }

    .starred-tree-number { left: 9px; background: #fff4cf; color: #855800; }
    .starred-tree-current-badge { right: 9px; background: #e4f1fa; color: #00679d; }
    .starred-tree-card.export-mode .starred-tree-current-badge { right: 38px; }

    .starred-tree-card-body { display: grid; gap: 8px; padding: 12px; }

    .starred-tree-name {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 5px 6px;
      margin: -5px -6px 0;
      background: transparent;
      color: #25364a;
      font: inherit;
      font-size: 12px;
      font-weight: 900;
    }

    .starred-tree-name:hover,
    .starred-tree-name:focus {
      outline: none;
      border-color: #cbd9e7;
      background: #f7fafc;
    }

    .starred-tree-status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .starred-tree-status {
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 8px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: .05em;
    }

    .starred-tree-status.partial { background: #fff4cf; color: #855800; }
    .starred-tree-status.complete { background: #e7f6ec; color: #24713c; }
    .starred-tree-time { color: #99a7b6; font-size: 8px; font-weight: 750; white-space: nowrap; }

    .starred-tree-summary {
      color: #5f7185;
      font-size: 10px;
      font-weight: 750;
      line-height: 1.4;
    }

    .starred-tree-summary.partial { color: #7d8997; font-weight: 850; }

    .starred-tree-rules {
      display: grid;
      gap: 3px;
      min-height: 42px;
      padding-top: 7px;
      border-top: 1px solid #edf2f7;
    }

    .starred-tree-rules-title {
      color: #8b99a8;
      font-size: 8px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: .06em;
    }

    .starred-tree-rule {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #40546a;
      font-size: 9px;
      font-weight: 780;
    }

    .starred-tree-rule-more { color: #94a3b8; font-size: 8px; font-weight: 800; }

    .starred-tree-actions {
      display: grid;
      grid-template-columns: minmax(0,1fr) auto;
      gap: 7px;
      opacity: .72;
      transition: opacity .16s ease;
    }

    .starred-tree-card:hover .starred-tree-actions,
    .starred-tree-card.current .starred-tree-actions { opacity: 1; }

    .starred-tree-open-card,
    .starred-tree-delete {
      min-height: 32px;
      border: 1px solid #d7e2ec;
      border-radius: 9px;
      background: #f7fafc;
      color: #40546a;
      cursor: pointer;
      font-size: 9px;
      font-weight: 850;
    }

    .starred-tree-open-card:hover:not(:disabled) {
      border-color: #79add2;
      background: #edf7fd;
      color: #075f93;
    }

    .starred-tree-open-card:disabled { cursor: default; color: #6f8398; background: #f2f6f9; }
    .starred-tree-delete { width: 34px; background: #fff; color: #98a5b3; font-size: 15px; }
    .starred-tree-delete:hover { border-color: #fecaca; background: #fff6f6; color: #b42318; }

    @media (max-width: 900px) {
      .starred-gallery-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 600px) {
      .starred-overlay { padding: 12px; }
      .starred-gallery { width: calc(100vw - 24px); max-height: calc(100vh - 24px); }
      .starred-gallery-grid { grid-template-columns: 1fr; padding: 12px; }
      .starred-export-toolbar { flex-wrap: wrap; }
    }
  `;
  document.head.appendChild(style);
}

function setExportSelection(id: number, selected: boolean) {
  if (selected) selectedForExport.add(id);
  else selectedForExport.delete(id);
  renderGallery();
}

function renderCard(tree: FavoriteTree, current: string | undefined): HTMLElement {
  const counts = nodeCounts(tree.snapshot.root);
  const complete = counts.open === 0;
  const selected = selectedForExport.has(tree.id);

  const card = document.createElement('article');
  card.className = [
    'starred-tree-card',
    tree.signature === current ? 'current' : '',
    exportMode ? 'export-mode' : '',
    selected ? 'export-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const visual = document.createElement('div');
  visual.className = 'starred-tree-visual';
  visual.appendChild(makeTreeThumbnail(tree));

  const number = document.createElement('span');
  number.className = 'starred-tree-number';
  number.textContent = `★ ${tree.id}`;
  visual.appendChild(number);

  if (tree.signature === current) {
    const badge = document.createElement('span');
    badge.className = 'starred-tree-current-badge';
    badge.textContent = 'Current';
    visual.appendChild(badge);
  }

  if (exportMode) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'starred-tree-select';
    checkbox.checked = selected;
    checkbox.title = `Select ${tree.label} for export`;
    checkbox.addEventListener('change', () => setExportSelection(tree.id, checkbox.checked));
    visual.appendChild(checkbox);
  }

  const body = document.createElement('div');
  body.className = 'starred-tree-card-body';

  const name = document.createElement('input');
  name.className = 'starred-tree-name';
  name.value = tree.label;
  name.title = 'Click to rename';
  name.maxLength = 60;
  name.addEventListener('input', () => renameFavorite(tree.id, name.value));
  name.addEventListener('blur', () => {
    tree.label = name.value.trim() || `Tree ${tree.id}`;
    name.value = tree.label;
  });

  const statusRow = document.createElement('div');
  statusRow.className = 'starred-tree-status-row';

  const status = document.createElement('span');
  status.className = `starred-tree-status ${complete ? 'complete' : 'partial'}`;
  status.textContent = complete ? 'Complete' : 'Partial';

  const time = document.createElement('span');
  time.className = 'starred-tree-time';
  time.textContent = formatSavedTime(tree.savedAt);
  statusRow.append(status, time);

  const summary = document.createElement('div');
  summary.className = `starred-tree-summary ${complete ? 'complete' : 'partial'}`;
  if (complete) {
    const accuracy = tree.accuracy ? `Accuracy ${tree.accuracy}` : 'Complete';
    summary.textContent = `${accuracy} · ${counts.leaves} ${counts.leaves === 1 ? 'leaf' : 'leaves'}`;
  } else {
    summary.textContent = 'Partial';
  }

  const rules = document.createElement('div');
  rules.className = 'starred-tree-rules';

  const rulesTitle = document.createElement('div');
  rulesTitle.className = 'starred-tree-rules-title';
  rulesTitle.textContent = tree.splitRules.length === 1 ? 'Split' : 'Splits';
  rules.appendChild(rulesTitle);

  if (tree.splitRules.length === 0) {
    const none = document.createElement('div');
    none.className = 'starred-tree-rule-more';
    none.textContent = 'No splits yet';
    rules.appendChild(none);
  } else {
    for (const split of tree.splitRules.slice(0, 4)) {
      const rule = document.createElement('div');
      rule.className = 'starred-tree-rule';
      rule.title = split;
      rule.textContent = split;
      rules.appendChild(rule);
    }

    if (tree.splitRules.length > 4) {
      const more = document.createElement('div');
      more.className = 'starred-tree-rule-more';
      const extra = tree.splitRules.length - 4;
      more.textContent = `+${extra} more split${extra === 1 ? '' : 's'}`;
      rules.appendChild(more);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'starred-tree-actions';

  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'starred-tree-open-card';
  restore.textContent = tree.signature === current ? 'Currently open' : 'Open tree';
  restore.disabled = tree.signature === current;
  restore.addEventListener('click', () => restoreFavorite(tree));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'starred-tree-delete';
  remove.title = `Delete ${tree.label}`;
  remove.textContent = '×';
  remove.addEventListener('click', () => removeFavorite(tree.id));

  actions.append(restore, remove);
  body.append(name, statusRow, summary, rules, actions);
  card.append(visual, body);
  return card;
}

function closeGallery() {
  galleryOpen = false;
  exportMode = false;
  selectedForExport.clear();
  document.getElementById(OVERLAY_ID)?.remove();
}

function openGallery() {
  galleryOpen = true;
  renderGallery();
}

function renderExportToolbar(gallery: HTMLElement) {
  if (!exportMode) return;

  const toolbar = document.createElement('div');
  toolbar.className = 'starred-export-toolbar';

  const selectAll = document.createElement('label');
  selectAll.className = 'starred-export-select-all';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = favorites.length > 0 && selectedForExport.size === favorites.length;
  checkbox.indeterminate = selectedForExport.size > 0 && selectedForExport.size < favorites.length;
  checkbox.addEventListener('change', () => {
    selectedForExport = checkbox.checked
      ? new Set(favorites.map((tree) => tree.id))
      : new Set<number>();
    renderGallery();
  });

  const selectLabel = document.createElement('span');
  selectLabel.textContent = 'Select all';
  selectAll.append(checkbox, selectLabel);

  const count = document.createElement('span');
  count.className = 'starred-export-count';
  count.textContent = `${selectedForExport.size} of ${favorites.length} selected`;

  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'starred-export-action';
  exportButton.textContent = 'Export selected';
  exportButton.disabled = selectedForExport.size === 0;
  exportButton.addEventListener('click', exportSelectedFavorites);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'starred-export-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    exportMode = false;
    selectedForExport.clear();
    renderGallery();
  });

  toolbar.append(selectAll, count, exportButton, cancel);
  gallery.appendChild(toolbar);
}

function renderGallery() {
  document.getElementById(OVERLAY_ID)?.remove();
  if (!galleryOpen) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'starred-overlay';
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) closeGallery();
  });

  const gallery = document.createElement('section');
  gallery.className = 'starred-gallery';

  const head = document.createElement('div');
  head.className = 'starred-gallery-head';

  const copy = document.createElement('div');
  copy.className = 'starred-gallery-head-copy';

  const title = document.createElement('b');
  title.textContent = `Favorite trees${favorites.length ? ` (${favorites.length})` : ''}`;

  const subtitle = document.createElement('span');
  subtitle.textContent = 'Saved partial and completed trees. Rename them, reopen them, or export a collection.';
  copy.append(title, subtitle);

  const headActions = document.createElement('div');
  headActions.className = 'starred-gallery-head-actions';

  const exportFavorites = document.createElement('button');
  exportFavorites.type = 'button';
  exportFavorites.className = 'starred-gallery-export';
  exportFavorites.textContent = exportMode ? 'Selecting…' : 'Export favorites';
  exportFavorites.disabled = favorites.length === 0;
  exportFavorites.addEventListener('click', () => {
    exportMode = true;
    selectedForExport = new Set(favorites.map((tree) => tree.id));
    renderGallery();
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'starred-gallery-close';
  close.textContent = '×';
  close.title = 'Close favorites';
  close.addEventListener('click', closeGallery);

  headActions.append(exportFavorites, close);
  head.append(copy, headActions);
  gallery.appendChild(head);

  renderExportToolbar(gallery);

  const grid = document.createElement('div');
  grid.className = 'starred-gallery-grid';

  if (favorites.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'starred-gallery-empty';
    empty.textContent = 'No favorites yet. Build or modify a tree and press ☆ Star to save that exact state.';
    grid.appendChild(empty);
  } else {
    const current = currentSignature();
    for (const tree of [...favorites].reverse()) {
      grid.appendChild(renderCard(tree, current));
    }
  }

  gallery.appendChild(grid);
  overlay.appendChild(gallery);
  document.body.appendChild(overlay);
}

function ensureHeaderControls() {
  injectStyles();

  const headerActions = document.querySelector('.header-actions');
  if (!headerActions) return;

  let row = document.getElementById(HEADER_ROW_ID);
  if (!row) {
    row = document.createElement('div');
    row.id = HEADER_ROW_ID;
    headerActions.appendChild(row);

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'ghost-button favorite-star-button';
    star.title = 'Save the exact current partial or completed tree';
    star.addEventListener('click', starCurrentTree);

    const favoritesButton = document.createElement('button');
    favoritesButton.type = 'button';
    favoritesButton.className = 'ghost-button favorite-open-button';
    favoritesButton.title = 'Browse favorite trees';
    favoritesButton.addEventListener('click', () => {
      if (galleryOpen) closeGallery();
      else openGallery();
    });

    const exportCurrent = document.createElement('button');
    exportCurrent.type = 'button';
    exportCurrent.className = 'ghost-button';
    exportCurrent.textContent = '⇩ Export';
    exportCurrent.title = 'Export the current tree';
    exportCurrent.addEventListener('click', () => findToolbarButton('export')?.click());

    row.append(star, favoritesButton, exportCurrent);
  }
}

function updateHeaderState() {
  ensureHeaderControls();

  const star = document.querySelector<HTMLButtonElement>('.favorite-star-button');
  const favoritesButton = document.querySelector<HTMLButtonElement>('.favorite-open-button');

  if (star) {
    const isFavorite = currentIsFavorite();
    star.textContent = isFavorite ? '★ Starred' : '☆ Star';
    star.classList.toggle('favorite-star-active', isFavorite);
    star.title = isFavorite
      ? 'This exact tree is already in Favorites'
      : 'Save the exact current partial or completed tree';
  }

  if (favoritesButton) {
    favoritesButton.innerHTML = `★ Favorites <span class="starred-tree-count">${favorites.length}</span>`;
  }
}

function syncAllControls() {
  organizeControls();
  ensureHeaderControls();
  updateHeaderState();
}

function scheduleStateSync() {
  if (syncScheduled) return;
  syncScheduled = true;
  afterReactPaint(() => {
    syncScheduled = false;
    syncAllControls();
    if (galleryOpen) renderGallery();
  });
}

document.addEventListener(
  'click',
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (
      target.closest('.choice-card') ||
      target.closest('.react-flow__node-arborenum') ||
      target.closest('.toolbar-row .ghost-button')
    ) {
      scheduleStateSync();
    }
  },
  true,
);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && galleryOpen) closeGallery();
});

document.addEventListener(
  'change',
  (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === 'file') {
      favorites = [];
      nextFavoriteId = 1;
      closeGallery();
      requestAnimationFrame(syncAllControls);
    }
  },
  true,
);

const observer = new MutationObserver(() => {
  organizeControls();
  ensureHeaderControls();
});
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['disabled'],
});

injectStyles();
syncAllControls();
