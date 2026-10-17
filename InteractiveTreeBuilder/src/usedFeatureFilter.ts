import type { AndOrGraph } from "./types";
type GraphLike = {
  split_nodes?: Array<{ feature?: number }>;
};

type MetaLike = {
  featureRegistry?: Array<Record<string, unknown>>;
  continuousGroups?: Record<string, number[]> | number[][];
};

type PayloadLike = {
  graph?: AndOrGraph;
  meta?: MetaLike & Record<string, unknown>;
};

function internalWindow() {
  return window as unknown as Window & Record<string, unknown>;
}

function usedInternalFeatures(graph: GraphLike | undefined): Set<number> {
  return new Set(
    (graph?.split_nodes ?? [])
      .map((split) => Number(split.feature))
      .filter((feature) => Number.isInteger(feature) && feature >= 0),
  );
}

function filterContinuousGroups(
  groups: MetaLike['continuousGroups'],
  used: Set<number>,
): MetaLike['continuousGroups'] {
  if (!groups) return groups;

  if (Array.isArray(groups)) {
    return groups
      .map((features) => features.filter((feature) => used.has(Number(feature))))
      .filter((features) => features.length > 0);
  }

  return Object.fromEntries(
    Object.entries(groups)
      .map(([name, features]) => [
        name,
        features.filter((feature) => used.has(Number(feature))),
      ] as const)
      .filter(([, features]) => features.length > 0),
  );
}

function filterPayloadToUsedFeatures(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;

  const payload = value as PayloadLike;
  if (!payload.graph || !payload.meta) return value;

  const used = usedInternalFeatures(payload.graph);

  if (Array.isArray(payload.meta.featureRegistry)) {
    payload.meta.featureRegistry = payload.meta.featureRegistry.filter((entry) =>
      used.has(Number(entry?.internalFeature)),
    );
  }

  payload.meta.continuousGroups = filterContinuousGroups(
    payload.meta.continuousGroups,
    used,
  );

  return payload;
}

function rememberFilteredPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as PayloadLike;
  if (!p.graph || !p.meta) return;

  const w = internalWindow();
  w.ARBORENUM_CURRENT_BUILDER_PAYLOAD = payload;
  w.ARBORENUM_ANDOR_GRAPH = p.graph;
  w.ARBORENUM_ANDOR_META = p.meta;
}

// arborenumPayload.ts runs first and validates/normalizes ArborEnum payloads.
// Wrap its JSON.parse hook so every later upload is reduced to features that
// actually occur in the graph before main.tsx consumes it.
const previousJsonParse = JSON.parse.bind(JSON);
JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
  const parsed = previousJsonParse(text, reviver as never);
  const filtered = filterPayloadToUsedFeatures(parsed);
  rememberFilteredPayload(filtered);
  return filtered;
}) as typeof JSON.parse;

// Do the same once for the embedded payload used at initial startup.
const w = internalWindow();
const embedded = w.ARBORENUM_BUILDER_PAYLOAD;
if (embedded) {
  const filtered = filterPayloadToUsedFeatures(embedded);
  w.ARBORENUM_BUILDER_PAYLOAD = filtered as Window['ARBORENUM_BUILDER_PAYLOAD'];
  rememberFilteredPayload(filtered);
}
