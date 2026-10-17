type RegistryEntry = {
  internalFeature: number;
  originalFeature: number;
  originalName: string;
  threshold: number;
  kind: 'binary_threshold' | 'continuous_threshold';
  continuousGroup: number | null;
};

type CurrentPayload = {
  meta?: {
    featureRegistry?: RegistryEntry[];
  };
};

type NativeSplitCard = {
  feature: number;
  splitId: number;
  objective?: string;
  card: HTMLElement;
};

type AvailableCut = RegistryEntry & NativeSplitCard;
type AvailableInterval = { cuts: AvailableCut[] };

const STYLE_ID = 'arborenum-threshold-interval-style';
const ENHANCER_CLASS = 'threshold-interval-enhancer';
const HIDDEN_CLASS = 'threshold-native-hidden';
const MIN_INTERVAL_PICKER_CHOICES = 11;

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
      originalFeature: Number(entry.originalFeature),
      originalName: String(entry.originalName),
      threshold: Number(entry.threshold),
      kind: entry.kind,
      continuousGroup:
        entry.continuousGroup === null ? null : Number(entry.continuousGroup),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.internalFeature) &&
        Number.isFinite(entry.threshold) &&
        entry.kind === 'continuous_threshold' &&
        Number.isInteger(entry.continuousGroup),
    );
}

function formatThreshold(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .threshold-native-hidden { display: none !important; }

    /* Loaded before React so dense native threshold cards never flash. */
    .choice-panel .choice-grid:has(> .choice-card.split-choice:nth-child(11)) {
      display: none !important;
    }

    .threshold-interval-enhancer {
      margin-top: 8px;
      color: #102033;
    }

    .threshold-interval-intro {
      margin: 0 0 10px;
      color: #64748b;
      font-size: 12px;
      line-height: 1.4;
    }

    .threshold-interval-list {
      display: grid;
      gap: 8px;
    }

    .threshold-interval-button {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 11px 12px;
      border: 1px solid #b9d7ee;
      border-left: 5px solid #0072b2;
      border-radius: 13px;
      background: #f8fcff;
      color: #102033;
      text-align: left;
      cursor: pointer;
      transition: background .14s ease, border-color .14s ease, transform .14s ease;
    }

    .threshold-interval-button:hover {
      background: #eef8ff;
      border-color: #7eb7dc;
      transform: translateY(-1px);
    }

    .threshold-interval-range,
    .threshold-interval-detail-title {
      min-width: 0;
      font-size: 14px;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
    }

    .threshold-interval-sub,
    .threshold-interval-detail-sub {
      margin-top: 3px;
      color: #64748b;
      font-size: 10px;
      font-weight: 700;
    }

    .threshold-interval-count {
      padding: 4px 8px;
      border-radius: 999px;
      background: #e6f4fc;
      color: #005f94;
      font-size: 11px;
      font-weight: 900;
      white-space: nowrap;
    }

    .threshold-interval-empty {
      padding: 12px;
      border: 1px solid #dbe4ee;
      border-radius: 12px;
      background: #f8fafc;
      color: #64748b;
      font-size: 12px;
      line-height: 1.4;
    }

    .threshold-interval-detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }

    .threshold-interval-detail-copy { min-width: 0; }

    .threshold-interval-back {
      flex: 0 0 auto;
      min-height: 31px;
      padding: 0 10px;
      border: 1px solid #bfdbfe;
      border-radius: 10px;
      background: #eff6ff;
      color: #1d4ed8;
      font-size: 11px;
      font-weight: 850;
      cursor: pointer;
    }

    .threshold-cut-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
    }

    .threshold-cut-button {
      min-width: 0;
      padding: 9px 10px;
      border: 1px solid #dbe4ee;
      border-radius: 11px;
      background: #fff;
      color: #102033;
      text-align: left;
      cursor: pointer;
      transition: background .14s ease, border-color .14s ease, transform .14s ease;
    }

    .threshold-cut-button:hover {
      background: #f1f8fd;
      border-color: #7eb7dc;
      transform: translateY(-1px);
    }

    .threshold-cut-value {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #005f94;
      font-size: 13px;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
    }

    .threshold-cut-meta {
      display: block;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #64748b;
      font-size: 9px;
      font-weight: 700;
    }
  `;
  document.head.appendChild(style);
}

function parseFeatureAndSplit(card: Element): NativeSplitCard | undefined {
  const sub = card.querySelector('.choice-card-sub')?.textContent ?? '';
  const featureMatch = sub.match(/feature\s+(\d+)/i);
  const splitMatch = sub.match(/split\s+#\s*(\d+)/i);
  const objectiveMatch = sub.match(/obj\s+([^·]+)/i);
  if (!featureMatch || !splitMatch) return undefined;

  return {
    feature: Number(featureMatch[1]),
    splitId: Number(splitMatch[1]),
    objective: objectiveMatch?.[1]?.trim(),
    card: card as HTMLElement,
  };
}

function restoreNativeControls(panel?: Element) {
  const root = panel ?? document;
  root
    .querySelectorAll(`.${HIDDEN_CLASS}`)
    .forEach((element) => element.classList.remove(HIDDEN_CLASS));
  root.querySelectorAll(`.${ENHANCER_CLASS}`).forEach((element) => element.remove());
}

function contiguousAvailableIntervals(
  candidates: RegistryEntry[],
  availableByFeature: Map<number, NativeSplitCard>,
): AvailableInterval[] {
  const intervals: AvailableInterval[] = [];
  let current: AvailableInterval | undefined;

  for (const candidate of candidates) {
    const native = availableByFeature.get(candidate.internalFeature);
    if (!native) {
      if (current) intervals.push(current);
      current = undefined;
      continue;
    }

    const cut: AvailableCut = { ...candidate, ...native };
    if (!current) current = { cuts: [cut] };
    else current.cuts.push(cut);
  }

  if (current) intervals.push(current);
  return intervals;
}

function fireNativeSplit(card: HTMLElement) {
  card.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    }),
  );
}

function enhanceThresholdPanel() {
  const panel = document.querySelector('.panel-section.choice-panel');
  if (!panel) return;

  const sectionTitle = panel.querySelector('.section-title')?.textContent?.trim() ?? '';
  if (!sectionTitle.startsWith('Thresholds for ')) {
    restoreNativeControls(panel);
    return;
  }

  const group = panel.querySelector('.choice-group');
  const grid = group?.querySelector('.choice-grid');
  if (!group || !grid) return;

  const availableCards = Array.from(grid.querySelectorAll('.choice-card.split-choice'))
    .map(parseFeatureAndSplit)
    .filter((x): x is NativeSplitCard => !!x);

  if (availableCards.length < MIN_INTERVAL_PICKER_CHOICES) {
    restoreNativeControls(panel);
    return;
  }

  const entries = registry();
  const firstRegistryEntry = entries.find(
    (entry) => entry.internalFeature === availableCards[0].feature,
  );
  if (!firstRegistryEntry || firstRegistryEntry.continuousGroup === null) return;

  const candidates = entries
    .filter(
      (entry) =>
        entry.continuousGroup === firstRegistryEntry.continuousGroup &&
        entry.originalFeature === firstRegistryEntry.originalFeature,
    )
    .sort(
      (a, b) =>
        a.internalFeature - b.internalFeature || a.threshold - b.threshold,
    );

  if (candidates.length < MIN_INTERVAL_PICKER_CHOICES) return;

  const availableByFeature = new Map(
    availableCards.map((entry) => [entry.feature, entry]),
  );
  const intervals = contiguousAvailableIntervals(candidates, availableByFeature);
  const signature = `${sectionTitle}|${availableCards
    .map((entry) => entry.feature)
    .sort((a, b) => a - b)
    .join(',')}`;

  const existing = panel.querySelector<HTMLElement>(`.${ENHANCER_CLASS}`);
  if (existing?.dataset.signature === signature) return;
  existing?.remove();

  grid.classList.add(HIDDEN_CLASS);
  panel.querySelector('.search-box')?.classList.add(HIDDEN_CLASS);

  const wrapper = document.createElement('div');
  wrapper.className = ENHANCER_CLASS;
  wrapper.dataset.signature = signature;
  grid.before(wrapper);

  const renderIntervals = () => {
    wrapper.replaceChildren();

    const intro = document.createElement('p');
    intro.className = 'threshold-interval-intro';
    intro.textContent =
      intervals.length === 1
        ? 'The available cuts form one contiguous threshold range. Choose the range to see its cutpoints.'
        : `The available cuts form ${intervals.length} contiguous threshold ranges. Choose a range to see its cutpoints.`;
    wrapper.appendChild(intro);

    if (intervals.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'threshold-interval-empty';
      empty.textContent =
        'No cuts for this feature are available under the current partial tree.';
      wrapper.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'threshold-interval-list';

    intervals.forEach((interval, intervalIndex) => {
      const first = interval.cuts[0];
      const last = interval.cuts[interval.cuts.length - 1];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'threshold-interval-button';

      const copy = document.createElement('div');
      const range = document.createElement('div');
      range.className = 'threshold-interval-range';
      range.textContent =
        interval.cuts.length === 1
          ? `≤ ${formatThreshold(first.threshold)}`
          : `${formatThreshold(first.threshold)} – ${formatThreshold(last.threshold)}`;

      const sub = document.createElement('div');
      sub.className = 'threshold-interval-sub';
      sub.textContent =
        interval.cuts.length === 1
          ? '1 available cutpoint'
          : `${interval.cuts.length} consecutive available cutpoints`;

      copy.append(range, sub);
      const count = document.createElement('span');
      count.className = 'threshold-interval-count';
      count.textContent = String(interval.cuts.length);
      button.append(copy, count);
      button.addEventListener('click', () => renderIntervalDetail(interval, intervalIndex));
      list.appendChild(button);
    });

    wrapper.appendChild(list);
  };

  const renderIntervalDetail = (
    interval: AvailableInterval,
    intervalIndex: number,
  ) => {
    wrapper.replaceChildren();

    const first = interval.cuts[0];
    const last = interval.cuts[interval.cuts.length - 1];
    const head = document.createElement('div');
    head.className = 'threshold-interval-detail-head';

    const copy = document.createElement('div');
    copy.className = 'threshold-interval-detail-copy';
    const title = document.createElement('div');
    title.className = 'threshold-interval-detail-title';
    title.textContent =
      interval.cuts.length === 1
        ? `Cut at ${formatThreshold(first.threshold)}`
        : `${formatThreshold(first.threshold)} – ${formatThreshold(last.threshold)}`;

    const sub = document.createElement('div');
    sub.className = 'threshold-interval-detail-sub';
    sub.textContent = `${interval.cuts.length} available cutpoint${
      interval.cuts.length === 1 ? '' : 's'
    } in range ${intervalIndex + 1} of ${intervals.length}`;
    copy.append(title, sub);

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'threshold-interval-back';
    back.textContent = '← Ranges';
    back.addEventListener('click', renderIntervals);
    head.append(copy, back);
    wrapper.appendChild(head);

    const cutGrid = document.createElement('div');
    cutGrid.className = 'threshold-cut-grid';

    for (const cut of interval.cuts) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'threshold-cut-button';
      button.title = `${cut.originalName} ≤ ${cut.threshold}`;

      const value = document.createElement('span');
      value.className = 'threshold-cut-value';
      value.textContent = `≤ ${formatThreshold(cut.threshold)}`;

      const meta = document.createElement('span');
      meta.className = 'threshold-cut-meta';
      meta.textContent = cut.objective
        ? `objective ${cut.objective}`
        : `split #${cut.splitId}`;

      button.append(value, meta);
      button.addEventListener('click', () => fireNativeSplit(cut.card));
      cutGrid.appendChild(button);
    }

    wrapper.appendChild(cutGrid);
  };

  renderIntervals();
}

injectStyles();

const observer = new MutationObserver(enhanceThresholdPanel);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});

enhanceThresholdPanel();
