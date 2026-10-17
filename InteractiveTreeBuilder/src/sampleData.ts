import type { AndOrGraph, FeatureMeta } from './types';
import payload from './samplePayload.json';

type FeatureRegistryEntry = {
  internalFeature: number;
  originalFeature: number;
  originalName: string;
  threshold: number;
  kind: 'binary_threshold' | 'continuous_threshold';
  continuousGroup: number | null;
};

const registry = payload.meta.featureRegistry as FeatureRegistryEntry[];

export const sampleGraph = payload.graph as AndOrGraph;

const featureNames = registry.map(
  (entry) => `${entry.originalName} <= ${entry.threshold}`,
);

const thresholds = Object.fromEntries(
  registry.map((entry) => [
    String(entry.internalFeature),
    entry.threshold,
  ]),
);

const continuousGroups: Record<string, number[]> = {};

for (const entry of registry) {
  if (
    entry.kind !== 'continuous_threshold' ||
    entry.continuousGroup === null
  ) {
    continue;
  }

  if (!continuousGroups[entry.originalName]) {
    continuousGroups[entry.originalName] = [];
  }

  continuousGroups[entry.originalName].push(entry.internalFeature);
}

export const sampleMeta: FeatureMeta & Record<string, unknown> = {
  ...payload.meta,

  featureNames,
  thresholds,
  continuousGroups,
};

// Keep the built-in sample visible to helper UI modules in exactly the same
// place uploaded ArborEnum payloads are exposed by arborenumPayload.ts.
const internalWindow = window as unknown as Window & Record<string, unknown>;
if (!internalWindow.ARBORENUM_CURRENT_BUILDER_PAYLOAD) {
  internalWindow.ARBORENUM_CURRENT_BUILDER_PAYLOAD = {
    graph: sampleGraph,
    meta: sampleMeta,
  };
}
