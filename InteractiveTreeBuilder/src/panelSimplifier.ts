type BuilderPayloadLike = {
  meta?: Record<string, unknown>;
};

type TreeCounts = {
  split: number;
  leaf: number;
  choice: number;
};

const internalWindow = window as unknown as Window & Record<string, unknown>;

let cachedTrainingSamples: string | null = null;
let lastPayloadLabel = '';
let scheduledFrame: number | null = null;

function setText(element: Element | null | undefined, text: string) {
  if (element && element.textContent !== text) {
    element.textContent = text;
  }
}

function currentTreeCounts(): TreeCounts | null {
  const split = document.querySelectorAll('.arborenum-node-split').length;
  const leaf = document.querySelectorAll('.arborenum-node-leaf').length;
  const choice = document.querySelectorAll('.arborenum-node-choice').length;

  if (split + leaf + choice === 0) return null;

  return { split, leaf, choice };
}

function featureCountFromCurrentPayload(): number | null {
  const payload = internalWindow.ARBORENUM_CURRENT_BUILDER_PAYLOAD as
    | BuilderPayloadLike
    | undefined;
  const meta = payload?.meta;

  if (!meta) return null;

  const featureNames = Array.isArray(meta.featureNames)
    ? meta.featureNames
    : [];
  const continuousGroups = meta.continuousGroups;

  const groups: unknown[][] = Array.isArray(continuousGroups)
    ? continuousGroups.filter(Array.isArray)
    : continuousGroups && typeof continuousGroups === 'object'
      ? Object.values(continuousGroups).filter(Array.isArray)
      : [];

  if (featureNames.length > 0) {
    const groupedFeatureIds = new Set<number>();

    for (const group of groups) {
      for (const feature of group) {
        const id = Number(feature);
        if (Number.isInteger(id) && id >= 0 && id < featureNames.length) {
          groupedFeatureIds.add(id);
        }
      }
    }

    const binaryFeatureCount = featureNames.length - groupedFeatureIds.size;
    return groups.length + binaryFeatureCount;
  }

  const registry = meta.featureRegistry;
  if (Array.isArray(registry)) {
    const originalFeatures = new Set<number>();

    for (const rawEntry of registry) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const originalFeature = Number(
        (rawEntry as Record<string, unknown>).originalFeature,
      );
      if (Number.isInteger(originalFeature) && originalFeature >= 0) {
        originalFeatures.add(originalFeature);
      }
    }

    if (originalFeatures.size > 0) {
      return originalFeatures.size;
    }
  }

  return null;
}

function hideRemainingChoicesSection(panel: Element) {
  for (const section of panel.querySelectorAll<HTMLElement>('.panel-section')) {
    const title = section.querySelector('.section-title')?.textContent?.trim();
    if (title === 'Remaining Choices') {
      section.hidden = true;
    }
  }
}

function simplifyTopMetrics(panel: Element, treeComplete: boolean) {
  const metrics = Array.from(panel.querySelectorAll<HTMLElement>('.metric-grid .metric'));
  if (metrics.length < 4) return;

  const [optimalMetric, boundMetric, samplesMetric, featuresMetric] = metrics;

  setText(
    optimalMetric.querySelector('span'),
    treeComplete ? 'Tree objective' : 'Best completion',
  );
  setText(boundMetric.querySelector('span'), 'Rashomon Bound');

  // main.tsx originally renders Training Samples in the fourth metric card.
  // Capture that value once before repurposing the card for Number of Features.
  // Do not reread it on later MutationObserver passes, because by then that
  // card contains the feature count rather than the sample count.
  if (cachedTrainingSamples === null) {
    const originalFourthLabel = featuresMetric.querySelector('span')?.textContent?.trim();
    const originalFourthValue = featuresMetric.querySelector('b')?.textContent?.trim();

    if (originalFourthLabel?.toLowerCase() === 'training samples' && originalFourthValue) {
      cachedTrainingSamples = originalFourthValue;
    }
  }

  const payload = internalWindow.ARBORENUM_CURRENT_BUILDER_PAYLOAD as BuilderPayloadLike | undefined;
  const sampleCount = Number(payload?.meta?.root_n);
  if (Number.isFinite(sampleCount) && sampleCount > 0) {
    setText(samplesMetric.querySelector('b'), sampleCount.toLocaleString());
  } else if (cachedTrainingSamples !== null) {
    setText(samplesMetric.querySelector('b'), cachedTrainingSamples);
  }
  setText(samplesMetric.querySelector('span'), 'Training Samples');

  const featureCount = featureCountFromCurrentPayload();
  if (featureCount !== null) {
    setText(featuresMetric.querySelector('b'), featureCount.toLocaleString());
  }
  setText(featuresMetric.querySelector('span'), 'Number of Features');
}

function simplifySlackCard(panel: Element) {
  const slackCard = panel.querySelector('.rashomon-slack-card');
  if (!slackCard) return;

  setText(
    slackCard.querySelector('.rashomon-slack-head span'),
    'Rashomon Slack Remaining',
  );
}

function simplifyChoiceBudget(panel: Element) {
  const choicePanel = panel.querySelector('.choice-panel');
  if (!choicePanel) return;

  const budget = choicePanel.querySelector('.budget-box');
  if (!budget) return;

  const items = Array.from(budget.children) as HTMLElement[];
  if (items.length < 2) return;

  setText(items[0].querySelector('span'), 'Available Here');
  setText(items[1].querySelector('span'), 'Best Here');

  for (let i = 2; i < items.length; i += 1) {
    items[i].hidden = true;
  }
}

function applyPanelSimplifications() {
  const panel = document.querySelector('.panel');
  if (!panel) return;

  const payloadLabel = document.querySelector('.payload-name')?.textContent?.trim() ?? '';
  if (payloadLabel !== lastPayloadLabel) {
    lastPayloadLabel = payloadLabel;
    cachedTrainingSamples = null;
  }

  const counts = currentTreeCounts();
  const treeComplete = counts?.choice === 0;

  hideRemainingChoicesSection(panel);
  simplifyTopMetrics(panel, treeComplete);
  simplifySlackCard(panel);
  simplifyChoiceBudget(panel);
}

function scheduleApply() {
  if (scheduledFrame !== null) return;

  scheduledFrame = window.requestAnimationFrame(() => {
    scheduledFrame = null;
    applyPanelSimplifications();
  });
}

const observer = new MutationObserver(scheduleApply);
observer.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
});

scheduleApply();
