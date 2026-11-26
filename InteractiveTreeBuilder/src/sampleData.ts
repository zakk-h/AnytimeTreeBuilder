import payload from './samplePayload.json';
import { normalizeArborEnumPayload, rememberCurrentPayload, type ArborEnumBuilderPayload } from './arborenumPayload';
import type { Dataset } from './liveDataset';

const sample = normalizeArborEnumPayload(payload as unknown as ArborEnumBuilderPayload);
export const sampleGraph = sample.graph;
export const sampleMeta = sample.meta;
export const sampleDataset = sample.meta.analysisDataset as Dataset | undefined;
const target = window as unknown as Window & Record<string, unknown>;
if (!target.ARBORENUM_CURRENT_BUILDER_PAYLOAD) rememberCurrentPayload(sample);
