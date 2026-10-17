import type { AndOrGraph } from './types';

export type ArborEnumFeatureRegistryEntry = {
  internalFeature: number;
  originalFeature: number;
  originalName: string;
  threshold: number;
  kind: 'binary_threshold' | 'continuous_threshold';
  continuousGroup: number | null;
};

export type ArborEnumBuilderMeta = Record<string, unknown> & {
  featureRegistry: ArborEnumFeatureRegistryEntry[];
};

export type ArborEnumBuilderPayload = {
  graph: AndOrGraph;
  meta: ArborEnumBuilderMeta;
};

function validateFeatureRegistry(registry: unknown): ArborEnumFeatureRegistryEntry[] {
  if (!Array.isArray(registry)) {
    throw new Error('ArborEnum payload meta.featureRegistry must be an array.');
  }

  const entries = registry as ArborEnumFeatureRegistryEntry[];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`featureRegistry[${i}] must be an object.`);
    }
    if (!Number.isInteger(entry.internalFeature) || entry.internalFeature !== i) {
      throw new Error(
        `featureRegistry must be index-addressable: expected internalFeature ${i}, got ${String(entry.internalFeature)}.`,
      );
    }
    if (!Number.isInteger(entry.originalFeature) || entry.originalFeature < 0) {
      throw new Error(`featureRegistry[${i}].originalFeature must be a nonnegative integer.`);
    }
    if (typeof entry.originalName !== 'string' || entry.originalName.length === 0) {
      throw new Error(`featureRegistry[${i}].originalName must be a nonempty string.`);
    }
    if (!Number.isFinite(Number(entry.threshold))) {
      throw new Error(`featureRegistry[${i}].threshold must be finite.`);
    }
    if (entry.kind !== 'binary_threshold' && entry.kind !== 'continuous_threshold') {
      throw new Error(
        `featureRegistry[${i}].kind must be "binary_threshold" or "continuous_threshold".`,
      );
    }
    if (
      entry.continuousGroup !== null &&
      (!Number.isInteger(entry.continuousGroup) || entry.continuousGroup < 0)
    ) {
      throw new Error(
        `featureRegistry[${i}].continuousGroup must be null or a nonnegative integer.`,
      );
    }
  }

  return entries;
}

function deriveContinuousGroups(
  registry: ArborEnumFeatureRegistryEntry[],
): Record<string, number[]> {
  const groups = new Map<number, { name: string; features: number[] }>();

  for (const entry of registry) {
    if (entry.kind !== 'continuous_threshold' || entry.continuousGroup === null) continue;

    const existing = groups.get(entry.continuousGroup);
    if (existing) {
      existing.features.push(entry.internalFeature);
    } else {
      groups.set(entry.continuousGroup, {
        name: entry.originalName,
        features: [entry.internalFeature],
      });
    }
  }

  const out: Record<string, number[]> = {};
  for (const [groupId, group] of groups) {
    const key = Object.prototype.hasOwnProperty.call(out, group.name)
      ? `${group.name} [${groupId}]`
      : group.name;
    out[key] = group.features;
  }
  return out;
}

export function normalizeArborEnumPayload(payload: ArborEnumBuilderPayload) {
  if (!payload?.graph) {
    throw new Error('ArborEnum builder payload must contain a top-level "graph" field.');
  }
  if (!payload?.meta) {
    throw new Error('ArborEnum builder payload must contain a top-level "meta" field.');
  }

  const registry = validateFeatureRegistry(payload.meta.featureRegistry);
  const featureNames = registry.map(
    (entry) => `${entry.originalName} <= ${entry.threshold}`,
  );
  const thresholds = Object.fromEntries(
    registry.map((entry) => [String(entry.internalFeature), Number(entry.threshold)]),
  );
  const continuousGroups = deriveContinuousGroups(registry);

  return {
    graph: payload.graph,
    meta: {
      ...payload.meta,
      featureNames,
      thresholds,
      continuousGroups,
    },
  };
}

function isArborEnumPayload(value: unknown): value is ArborEnumBuilderPayload {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (!obj.graph || !obj.meta || typeof obj.meta !== 'object') return false;
  return Array.isArray((obj.meta as Record<string, unknown>).featureRegistry);
}

export function rememberCurrentPayload(payload: unknown) {
  const internalWindow = window as unknown as Window & Record<string, unknown>;
  internalWindow.ARBORENUM_CURRENT_BUILDER_PAYLOAD = payload;
}

// Normalize ArborEnum JSON uploads before main.tsx consumes them.
const nativeJsonParse = JSON.parse.bind(JSON);
JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
  const parsed = nativeJsonParse(text, reviver as never);

  if (!isArborEnumPayload(parsed)) {
    return parsed;
  }

  const normalized = normalizeArborEnumPayload(parsed);
  rememberCurrentPayload(normalized);
  return normalized;
}) as typeof JSON.parse;

// Normalize the payload embedded by ArborEnum.save_builder_html().
const internalWindow = window as unknown as Window & Record<string, unknown>;
const embeddedPayload = internalWindow.ARBORENUM_BUILDER_PAYLOAD as
  | ArborEnumBuilderPayload
  | undefined;

if (embeddedPayload) {
  const normalized = normalizeArborEnumPayload(embeddedPayload);
  rememberCurrentPayload(normalized);
  internalWindow.ARBORENUM_BUILDER_PAYLOAD = normalized;
  internalWindow.ARBORENUM_ANDOR_GRAPH = normalized.graph;
  internalWindow.ARBORENUM_ANDOR_META = normalized.meta;
}
