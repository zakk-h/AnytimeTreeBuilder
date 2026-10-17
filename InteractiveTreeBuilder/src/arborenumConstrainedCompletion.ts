type ArborEnumFeature = {
  internalFeature: number;
  originalFeature: number;
  originalName: string;
  threshold: number;
};

type CurrentPayload = {
  graph?: {
    leaf_nodes?: Array<{ prediction: number }>;
    split_nodes?: Array<{ id: number; feature: number }>;
    trie_nodes?: Array<{ split_ids: number[] }>;
  };
  meta?: Record<string, unknown> & { featureRegistry?: ArborEnumFeature[] };
};

type SampleSpec = {
  mode: 'sample';
  featureTruth: Record<string, boolean>;
  targetPrediction: number;
};

type ConstraintSpec =
  | { mode: 'avoid'; forbiddenInternalFeatures: number[] }
  | SampleSpec;

type ConstraintResult = { ok: boolean; message?: string };

const STYLE_ID = 'arborenum-constrained-completion-style';
const BUTTON_ID = 'arborenum-constrained-completion-button';
const MODAL_ID = 'arborenum-constrained-completion-modal';

function internalWindow() {
  return window as unknown as Window & Record<string, unknown>;
}

function currentPayload(): CurrentPayload | undefined {
  const w = internalWindow();
  return (w.ARBORENUM_CURRENT_BUILDER_PAYLOAD ?? w.ARBORENUM_BUILDER_PAYLOAD) as
    | CurrentPayload
    | undefined;
}

function registry(): ArborEnumFeature[] {
  const raw = currentPayload()?.meta?.featureRegistry;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({
      internalFeature: Number(e.internalFeature),
      originalFeature: Number(e.originalFeature),
      originalName: String(e.originalName),
      threshold: Number(e.threshold),
    }))
    .filter(
      (e) =>
        Number.isInteger(e.internalFeature) &&
        Number.isInteger(e.originalFeature) &&
        e.originalName.length > 0 &&
        Number.isFinite(e.threshold),
    );
}

function originalFeatures() {
  const out = new Map<number, string>();
  for (const e of registry()) if (!out.has(e.originalFeature)) out.set(e.originalFeature, e.originalName);
  return Array.from(out, ([id, name]) => ({ id, name })).sort((a, b) => a.id - b.id);
}

function predictions() {
  const names = currentPayload()?.meta?.classNames;
  if (Array.isArray(names)) return names.map((_, index) => index);
  return Array.from(
    new Set(
      (currentPayload()?.graph?.leaf_nodes ?? [])
        .map((leaf) => Number(leaf.prediction))
        .filter((x) => Number.isFinite(x) && x >= 0),
    ),
  ).sort((a, b) => a - b);
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .constraint-backdrop{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.36);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px}
    .constraint-modal{width:min(800px,calc(100vw - 48px));max-height:min(860px,calc(100vh - 48px));overflow:auto;border-radius:18px;background:white;border:1px solid #dbe4ee;box-shadow:0 30px 80px rgba(15,23,42,.24);color:#162033}
    .constraint-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:22px 24px 18px;border-bottom:1px solid #e7edf4}.constraint-header-copy{display:grid;gap:4px}.constraint-header-copy b{font-size:18px}.constraint-header-copy span,.constraint-help{color:#607086;font-size:13px;line-height:1.45}
    .constraint-close{border:0;background:#f4f7fa;width:34px;height:34px;border-radius:9px;cursor:pointer;font-size:20px;color:#526277}
    .constraint-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:18px 24px 0}.constraint-tabs button{border:1px solid #dbe4ee;background:#f8fafc;border-radius:10px;padding:11px 14px;font-weight:750;color:#526277;cursor:pointer}.constraint-tabs button.active{border-color:#8ab4e2;background:#edf6ff;color:#244f7d}
    .constraint-body{padding:18px 24px 24px;display:grid;gap:16px}.constraint-subheading{font-size:12px;font-weight:850;letter-spacing:.06em;text-transform:uppercase;color:#43546a}.constraint-divider{height:1px;background:#e7edf4;margin:2px 0}
    .constraint-check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:330px;overflow:auto;padding-right:4px}.constraint-check-row{display:flex;align-items:center;gap:9px;border:1px solid #e0e7ef;border-radius:9px;padding:9px 10px;background:#fbfdff;font-size:13px}
    .constraint-sample-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px;max-height:360px;overflow:auto;padding-right:4px}.constraint-sample-grid label,.constraint-prediction-row{display:grid;gap:5px;font-size:12px;color:#526277}.constraint-sample-grid input,.constraint-prediction-row select{width:100%;box-sizing:border-box;border:1px solid #d8e1eb;border-radius:8px;padding:9px 10px;background:white;color:#172033;font:inherit}
    .constraint-primary{justify-self:start;border:0;border-radius:10px;padding:11px 15px;background:#315f8f;color:white;font-weight:800;cursor:pointer}.constraint-primary:hover{filter:brightness(.97)}.constraint-message{border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;color:#9a4f10;padding:10px 12px;font-size:13px;line-height:1.4}
    @media(max-width:680px){.constraint-tabs,.constraint-check-grid,.constraint-sample-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function closeModal() {
  document.getElementById(MODAL_ID)?.remove();
}

function findOptimalButton() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.toolbar-row button')).find((button) =>
    button.textContent?.trim().toLowerCase().includes('optimal'),
  );
}

function showMessage(message: HTMLElement, text: string) {
  message.textContent = text;
  message.style.display = 'block';
}

async function invokeConstraint(spec: ConstraintSpec): Promise<ConstraintResult> {
  if (window.ARBORENUM_NATIVE_CONSTRAINED_COMPLETION) return window.ARBORENUM_NATIVE_CONSTRAINED_COMPLETION(spec);
  const optimal = findOptimalButton();
  if (!optimal || optimal.disabled) return { ok: false, message: 'The tree has no unfinished choices to complete.' };

  const w = internalWindow();
  w.ARBORENUM_CONSTRAINED_COMPLETION_RESULT = undefined;
  w.ARBORENUM_CONSTRAINED_COMPLETION = spec;
  try {
    optimal.click();
  } finally {
    w.ARBORENUM_CONSTRAINED_COMPLETION = undefined;
  }
  return (w.ARBORENUM_CONSTRAINED_COMPLETION_RESULT as ConstraintResult | undefined) ?? {
    ok: false,
    message: 'No feasible constrained completion was found.',
  };
}

async function finish(pending: Promise<ConstraintResult>, message: HTMLElement) {
  showMessage(message, 'Computing completion…');
  try {
    const result = await pending;
    if (result.ok) closeModal();
    else showMessage(message, result.message ?? 'No feasible constrained completion was found.');
  } catch (error) { showMessage(message, String(error)); }
}

function makeAvoidSelector() {
  const features = originalFeatures();
  if (!features.length) return undefined;
  const grid = document.createElement('div');
  grid.className = 'constraint-check-grid';
  for (const feature of features) {
    const label = document.createElement('label');
    label.className = 'constraint-check-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.originalFeature = String(feature.id);
    const name = document.createElement('span');
    name.textContent = feature.name;
    label.append(input, name);
    grid.appendChild(label);
  }
  return grid;
}

function selectedOriginalFeatures(grid: HTMLElement) {
  return Array.from(grid.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map((input) =>
    Number(input.dataset.originalFeature),
  );
}

function forbiddenInternalFeatures(selected: number[]) {
  const ids = new Set(selected);
  return registry().filter((e) => ids.has(e.originalFeature)).map((e) => e.internalFeature);
}

function makeSampleControls() {
  const features = originalFeatures();
  const reg = registry();
  if (!features.length || !reg.length) return undefined;

  const root = document.createElement('div');
  root.style.display = 'contents';
  const grid = document.createElement('div');
  grid.className = 'constraint-sample-grid';
  const inputs = new Map<number, HTMLInputElement>();

  for (const feature of features) {
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = feature.name;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.placeholder = 'blank = unknown';
    inputs.set(feature.id, input);
    label.append(name, input);
    grid.appendChild(label);
  }

  const predictionLabel = document.createElement('label');
  predictionLabel.className = 'constraint-prediction-row';
  const predictionName = document.createElement('span');
  predictionName.textContent = 'Prediction to ensure';
  const select = document.createElement('select');
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Choose class';
  select.appendChild(blank);
  for (const prediction of predictions()) {
    const option = document.createElement('option');
    option.value = String(prediction);
    option.textContent = `class ${prediction}`;
    select.appendChild(option);
  }
  predictionLabel.append(predictionName, select);
  root.append(grid, predictionLabel);
  return { root, features, reg, inputs, select };
}

function readSampleSpec(controls: NonNullable<ReturnType<typeof makeSampleControls>>, message: HTMLElement): SampleSpec | undefined {
  const values = new Map<number, number>();
  for (const feature of controls.features) {
    const raw = controls.inputs.get(feature.id)?.value.trim() ?? '';
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      showMessage(message, `Enter a numeric value for ${feature.name}, or leave it blank.`);
      return undefined;
    }
    values.set(feature.id, value);
  }

  const targetPrediction = Number(controls.select.value);
  if (!controls.select.value || !Number.isFinite(targetPrediction)) {
    showMessage(message, 'Choose the prediction to ensure.');
    return undefined;
  }

  const featureTruth: Record<string, boolean> = {};
  for (const entry of controls.reg) {
    const value = values.get(entry.originalFeature);
    if (value === undefined) continue;
    featureTruth[String(entry.internalFeature)] = value <= entry.threshold;
  }
  return { mode: 'sample', featureTruth, targetPrediction };
}

function avoidPanel(message: HTMLElement) {
  const body = document.createElement('div');
  body.className = 'constraint-body';
  const help = document.createElement('div');
  help.className = 'constraint-help';
  help.textContent = 'Select one or more original features. The final tree will not use any threshold of those features. Existing splits are kept; if one already uses a selected feature, rewind it first.';
  body.appendChild(help);

  const grid = makeAvoidSelector();
  if (!grid) {
    const empty = document.createElement('div');
    empty.className = 'constraint-message';
    empty.textContent = 'This payload does not contain ArborEnum featureRegistry metadata.';
    body.appendChild(empty);
    return body;
  }

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'constraint-primary';
  run.textContent = 'Build optimal constrained completion';
  run.onclick = () => {
    const selected = selectedOriginalFeatures(grid);
    if (!selected.length) return showMessage(message, 'Select at least one feature to avoid.');
    finish(invokeConstraint({ mode: 'avoid', forbiddenInternalFeatures: forbiddenInternalFeatures(selected) }), message);
  };
  body.append(grid, run);
  return body;
}

function samplePanel(message: HTMLElement) {
  const body = document.createElement('div');
  body.className = 'constraint-body';
  const help = document.createElement('div');
  help.className = 'constraint-help';
  help.textContent = 'Enter any feature values you know and leave the rest blank. Blank means unknown: the completed tree must produce the requested prediction for every full sample consistent with the values you entered. If an unknown feature is used by a split, both branches are constrained.';
  body.appendChild(help);

  const controls = makeSampleControls();
  if (!controls) {
    const empty = document.createElement('div');
    empty.className = 'constraint-message';
    empty.textContent = 'Sample constraints require ArborEnum featureRegistry metadata.';
    body.appendChild(empty);
    return body;
  }

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'constraint-primary';
  run.textContent = 'Build optimal constrained completion';
  run.onclick = () => {
    const spec = readSampleSpec(controls, message);
    if (spec) finish(invokeConstraint(spec), message);
  };
  body.append(controls.root, run);
  return body;
}

function partialTreeUsesSelectedFeature(selected: number[]) {
  const selectedIds = new Set(selected);
  const names = Array.from(new Set(registry().filter((e) => selectedIds.has(e.originalFeature)).map((e) => e.originalName)));
  const titles = Array.from(document.querySelectorAll<HTMLElement>('.arborenum-node-split .node-title')).map((node) =>
    (node.getAttribute('title') || node.textContent || '').trim().toLowerCase().replace(/≤/g, '<=').replace(/\s+/g, ' '),
  );
  return names.find((name) => {
    const n = name.trim().toLowerCase().replace(/\s+/g, ' ');
    return titles.some((title) => title === n || title.startsWith(`${n} <=`) || title.startsWith(`${n} <`) || title.startsWith(`${n} =`));
  });
}

async function invokeSampleWhileAvoiding(spec: SampleSpec, forbiddenFeatures: number[]): Promise<ConstraintResult> {
  if (window.ARBORENUM_NATIVE_CONSTRAINED_COMPLETION) return window.ARBORENUM_NATIVE_CONSTRAINED_COMPLETION({ ...spec, forbiddenInternalFeatures: forbiddenFeatures });
  const graph = currentPayload()?.graph;
  const tries = graph?.trie_nodes;
  const splits = graph?.split_nodes;
  if (!tries || !splits) {
    return { ok: false, message: 'Combined constraints require trie_nodes and split_nodes in the ArborEnum payload.' };
  }

  const forbidden = new Set(forbiddenFeatures);
  const splitById = new Map(splits.map((split) => [split.id, split]));
  const saved = tries.map((trie) => trie.split_ids);
  try {
    for (const trie of tries) {
      trie.split_ids = trie.split_ids.filter((id) => {
        const split = splitById.get(id);
        return !split || !forbidden.has(split.feature);
      });
    }
    return invokeConstraint(spec);
  } finally {
    tries.forEach((trie, i) => {
      trie.split_ids = saved[i];
    });
  }
}

function bothPanel(message: HTMLElement) {
  const body = document.createElement('div');
  body.className = 'constraint-body';
  const help = document.createElement('div');
  help.className = 'constraint-help';
  help.textContent = 'Apply both constraints at once: avoid the selected features everywhere in the completed tree while also guaranteeing the requested prediction for every full sample consistent with the entered values. The result is the optimal completion satisfying both constraints and the Rashomon bound.';
  body.appendChild(help);

  const grid = makeAvoidSelector();
  const controls = makeSampleControls();
  if (!grid || !controls) {
    const empty = document.createElement('div');
    empty.className = 'constraint-message';
    empty.textContent = 'Combined constraints require ArborEnum featureRegistry metadata.';
    body.appendChild(empty);
    return body;
  }

  const avoidTitle = document.createElement('div');
  avoidTitle.className = 'constraint-subheading';
  avoidTitle.textContent = 'Features to avoid';
  const divider = document.createElement('div');
  divider.className = 'constraint-divider';
  const sampleTitle = document.createElement('div');
  sampleTitle.className = 'constraint-subheading';
  sampleTitle.textContent = 'Prediction guarantee';
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'constraint-primary';
  run.textContent = 'Build optimal completion satisfying both';
  run.onclick = () => {
    const selected = selectedOriginalFeatures(grid);
    if (!selected.length) return showMessage(message, 'Select at least one feature to avoid.');
    const alreadyUsed = partialTreeUsesSelectedFeature(selected);
    if (alreadyUsed) return showMessage(message, `${alreadyUsed} is already used in the partial tree. Rewind that split first if the final tree must avoid it.`);
    const spec = readSampleSpec(controls, message);
    if (!spec) return;
    finish(invokeSampleWhileAvoiding(spec, forbiddenInternalFeatures(selected)), message);
  };

  body.append(avoidTitle, grid, divider, sampleTitle, controls.root, run);
  return body;
}

function openModal() {
  closeModal();
  injectStyles();
  const backdrop = document.createElement('div');
  backdrop.id = MODAL_ID;
  backdrop.className = 'constraint-backdrop';
  const modal = document.createElement('div');
  modal.className = 'constraint-modal';
  modal.onmousedown = (event) => event.stopPropagation();

  const header = document.createElement('div');
  header.className = 'constraint-header';
  const copy = document.createElement('div');
  copy.className = 'constraint-header-copy';
  const title = document.createElement('b');
  title.textContent = 'Constrained completion';
  const subtitle = document.createElement('span');
  subtitle.textContent = 'Optimally fill every unfinished node subject to constraints and the current Rashomon budget.';
  copy.append(title, subtitle);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'constraint-close';
  close.textContent = '×';
  close.onclick = closeModal;
  header.append(copy, close);

  const tabs = document.createElement('div');
  tabs.className = 'constraint-tabs';
  const avoidTab = document.createElement('button');
  avoidTab.textContent = 'Avoid features';
  const sampleTab = document.createElement('button');
  sampleTab.textContent = 'Ensure prediction';
  const bothTab = document.createElement('button');
  bothTab.textContent = 'Both';
  tabs.append(avoidTab, sampleTab, bothTab);

  const content = document.createElement('div');
  const message = document.createElement('div');
  message.className = 'constraint-message';
  message.style.display = 'none';
  message.style.margin = '0 24px 24px';

  const show = (mode: 'avoid' | 'sample' | 'both') => {
    avoidTab.classList.toggle('active', mode === 'avoid');
    sampleTab.classList.toggle('active', mode === 'sample');
    bothTab.classList.toggle('active', mode === 'both');
    message.style.display = 'none';
    content.replaceChildren(mode === 'avoid' ? avoidPanel(message) : mode === 'sample' ? samplePanel(message) : bothPanel(message));
  };
  avoidTab.onclick = () => show('avoid');
  sampleTab.onclick = () => show('sample');
  bothTab.onclick = () => show('both');

  modal.append(header, tabs, content, message);
  backdrop.appendChild(modal);
  backdrop.onmousedown = closeModal;
  document.body.appendChild(backdrop);
  show('avoid');
}

function installButton() {
  const toolbar = document.querySelector('.toolbar-row');
  if (!toolbar || document.getElementById(BUTTON_ID)) return;
  const optimal = findOptimalButton();
  if (!optimal) return;
  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.className = 'ghost-button';
  button.textContent = 'Constrained';
  button.title = 'Optimally complete the unfinished nodes subject to a constraint';
  button.disabled = optimal.disabled;
  button.onclick = openModal;
  optimal.insertAdjacentElement('afterend', button);
}

function syncButton() {
  installButton();
  const button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  const optimal = findOptimalButton();
  if (button && optimal && button.disabled !== optimal.disabled) button.disabled = optimal.disabled;
}

injectStyles();
syncButton();
const observer = new MutationObserver(syncButton);
observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
