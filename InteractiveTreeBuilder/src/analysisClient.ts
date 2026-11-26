import AnalysisWorker from './graphAnalysis.worker?worker&inline';
import type { AnalysisProgress, AnalysisResult } from './graphAnalysis';
import type { AndOrGraph, BuildNode } from './types';
import type { Dataset } from './liveDataset';
export function analyzeGraphInWorker(graph: AndOrGraph, meta: Record<string, unknown>, tree: BuildNode, dataset: Dataset | undefined, signal: AbortSignal, progress: (value: AnalysisProgress) => void): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException('Analysis cancelled', 'AbortError'));
            return;
        }
        const worker = new AnalysisWorker();
        const stop = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
        const abort = () => { stop(); reject(new DOMException('Analysis cancelled', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true });
        worker.onmessage = event => {
            if (event.data.progress)
                progress(event.data.progress);
            else if (event.data.error) {
                stop();
                reject(new Error(event.data.error));
            }
            else if (event.data.result) {
                stop();
                resolve(event.data.result);
            }
        };
        worker.onerror = event => { stop(); reject(new Error(event.message || 'Graph analysis worker failed.')); };
        worker.postMessage({ graph, meta, tree, dataset });
    });
}
