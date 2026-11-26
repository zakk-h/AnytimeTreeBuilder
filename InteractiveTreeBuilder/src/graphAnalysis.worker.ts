import { analyzeGraph } from './graphAnalysis';
import type { AndOrGraph, BuildNode } from './types';
import type { Dataset } from './liveDataset';
type Input = {
    graph: AndOrGraph;
    meta: Record<string, unknown>;
    tree: BuildNode;
    dataset?: Dataset;
};
const scope = self as unknown as {
    onmessage: (event: MessageEvent<Input>) => void;
    postMessage: (value: unknown) => void;
};
scope.onmessage = event => {
    try {
        const { graph, meta, tree, dataset } = event.data;
        const result = analyzeGraph(graph, meta, tree, dataset, progress => scope.postMessage({ progress }));
        scope.postMessage({ result });
    }
    catch (error) {
        scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
