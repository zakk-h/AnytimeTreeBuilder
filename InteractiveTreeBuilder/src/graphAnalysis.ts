import type { AndOrGraph, BuildNode, LeafNode, SplitNode, TrieNode } from './types';
import type { Dataset } from './liveDataset';
export type AnalysisProgress = {
    stage: number;
    completed_features: number;
    feature_count: number;
    current_feature: string;
};
export type AnalysisResult = {
    unavailable_reason?: string;
    accuracy_available?: boolean;
    abstention_available?: boolean;
    session_id: string;
    checkpoint: number;
    tree_count: string;
    sample_count: number;
    exact: boolean;
    leaf_distribution: {
        value: number;
        count: string;
        probability: number;
    }[];
    abstention_distribution: {
        value: number;
        count: string;
        probability: number;
    }[];
    objective_distribution: {
        value: number;
        count: string;
        probability: number;
    }[];
    accuracy: {
        min: number | null;
        max: number | null;
        undefined_count: string;
    };
    importance: {
        name: string;
        min: number;
        max: number;
    }[];
    disagreement: {
        row: number;
        counts: string[];
        probabilities: number[];
        disagreement: number;
    }[];
    prediction_labels: string[];
    class_count: number;
    abstention_enabled: boolean;
    mse?: {
        min: number;
        max: number;
    };
    task: string;
    timings: {
        total_seconds: number;
    };
};
export type GraphConstraint = {
    forbiddenInternalFeatures?: number[];
    featureTruth?: Record<string, boolean>;
    targetPrediction?: number;
    mode?: string;
    minimizeAbstention?: boolean;
    maxLeaves?: number;
    maxAbstainedSamples?: number;
};
type Registry = {
    internalFeature: number;
    originalFeature: number;
    originalName: string;
    threshold: number;
};
type Plan = {
    leaf?: LeafNode;
    split?: SplitNode;
    left?: Plan;
    right?: Plan;
    fixed?: BuildNode;
    trie: number;
};
type Cell = {
    cost: number;
    leaves: number;
    abstained: number;
    error: number;
    count: bigint;
    plan: Plan;
    key: string;
};
type Context = {
    id: number;
    trie: TrieNode;
    fixed?: BuildNode;
    required: boolean;
    mask: number;
    minimum: number;
    budget: number;
    alternatives: Alternative[];
    cells: Cell[];
    byKey: Map<string, Cell>;
};
type Alternative = {
    leaf: LeafNode;
} | {
    split: SplitNode;
    left: Context;
    right: Context;
};
type Range = {
    cell: Cell;
    min: number;
    max: number;
};
const tolerance = (x: number) => 1e-9 * Math.max(1, Math.abs(x));
const fits = (cost: number, budget: number) => Number.isFinite(cost) && (budget === Infinity || cost <= budget + 8 * Number.EPSILON * Math.max(1, Math.abs(budget)));
const stateKey = (cost: number, leaves: number, abstained: number, error: number) => `${cost}:${leaves}:${abstained}:${error}`;
const finite = (value: unknown, name: string, fallback?: number): number => {
    if (value === undefined || value === null) {
        if (fallback !== undefined)
            return fallback;
        throw new Error(`Missing ${name}.`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        throw new Error(`Invalid ${name}.`);
    return value;
};
export function countFraction(count: bigint, total: bigint): number {
    if (!total)
        return 0;
    const totalShift = BigInt(Math.max(0, total.toString(2).length - 53));
    const countShift = BigInt(Math.max(0, count.toString(2).length - 53));
    return Number(count >> countShift) / Number(total >> totalShift) * 2 ** Number(countShift - totalShift);
}
class Masks {
    values: Uint32Array[] = [];
    private buckets = new Map<number, number[]>();
    private parts = new Map<string, [
        number,
        number
    ]>();
    private truths = new Map<number, Uint32Array>();
    readonly full: number;
    constructor(private data: Dataset, private registry: Map<number, Registry>) {
        const full = new Uint32Array(Math.ceil(data.y.length / 32));
        full.fill(0xffffffff);
        if (data.y.length % 32)
            full[full.length - 1] = 0xffffffff >>> (32 - data.y.length % 32);
        this.full = this.intern(full);
    }
    intern(value: Uint32Array): number {
        let hash = 2166136261;
        for (const word of value)
            hash = Math.imul(hash ^ word, 16777619);
        const bucket = this.buckets.get(hash) ?? [];
        for (const id of bucket)
            if (this.values[id].every((word, i) => word === value[i]))
                return id;
        const id = this.values.length;
        this.values.push(value);
        bucket.push(id);
        this.buckets.set(hash, bucket);
        return id;
    }
    split(mask: number, feature: number): [
        number,
        number
    ] {
        const key = `${mask}:${feature}`, cached = this.parts.get(key);
        if (cached)
            return cached;
        let truth = this.truths.get(feature);
        if (!truth) {
            const f = this.registry.get(feature);
            if (!f)
                throw new Error(`Missing metadata for feature ${feature}.`);
            truth = new Uint32Array(this.values[mask].length);
            for (let i = 0; i < this.data.X.length; ++i)
                if (this.data.X[i][f.originalFeature] <= f.threshold)
                    truth[i >>> 5] |= 1 << (i & 31);
            this.truths.set(feature, truth);
        }
        const left = new Uint32Array(truth.length), right = new Uint32Array(truth.length), input = this.values[mask];
        for (let i = 0; i < truth.length; ++i) {
            left[i] = input[i] & truth[i];
            right[i] = input[i] & ~truth[i];
        }
        const result: [
            number,
            number
        ] = [this.intern(left), this.intern(right)];
        this.parts.set(key, result);
        return result;
    }
    rows(mask: number, fn: (row: number) => void) {
        const words = this.values[mask];
        for (let i = 0; i < words.length; ++i) {
            let word = words[i];
            while (word) {
                const bit = 31 - Math.clz32(word & -word);
                fn((i << 5) + bit);
                word = (word & (word - 1)) >>> 0;
            }
        }
    }
    size(mask: number): number {
        let count = 0;
        for (let word of this.values[mask]) {
            word -= (word >>> 1) & 0x55555555;
            word = (word & 0x33333333) + ((word >>> 2) & 0x33333333);
            count += (((word + (word >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
        }
        return count;
    }
}
function index<T extends {
    id: number;
}>(values: T[], name: string): Map<number, T> {
    if (!Array.isArray(values))
        throw new Error(`Missing graph ${name}.`);
    const result = new Map<number, T>();
    for (const item of values) {
        if (!Number.isSafeInteger(item.id) || item.id < 0 || result.has(item.id))
            throw new Error(`Invalid or duplicate ${name} ID.`);
        result.set(item.id, item);
    }
    return result;
}
class Profiles {
    root: Context;
    contexts: Context[] = [];
    order: Context[] = [];
    private built = new Set<Context>();
    private memo = new Map<string, Context>();
    private active = new Set<number>();
    private nodeMasks = new Map<number, number>();
    private tries: Map<number, TrieNode>;
    private splits: Map<number, SplitNode>;
    private leaves: Map<number, LeafNode>;
    private registry = new Map<number, Registry>();
    private histogram = new Map<number, number[]>();
    private masks?: Masks;
    private forbidden: Set<number>;
    private ticks = 0;
    private started = performance.now();
    readonly regression: boolean;
    readonly n: number;
    readonly gamma: number;
    readonly eta: number;
    abstention = false;
    accuracy = true;
    abstentionAvailable = true;
    constructor(readonly graph: AndOrGraph, readonly meta: Record<string, unknown>, readonly partial: BuildNode, readonly data?: Dataset, readonly constraints: GraphConstraint = {}, readonly progress?: (p: AnalysisProgress) => void) {
        this.regression = meta.task === 'regression';
        this.tries = index(graph.trie_nodes, 'trie_nodes');
        this.splits = index(graph.split_nodes, 'split_nodes');
        this.leaves = index(graph.leaf_nodes, 'leaf_nodes');
        const root = this.tries.get(graph.root_trie_id);
        if (!root)
            throw new Error('Graph root does not exist.');
        this.n = finite(meta.root_n, 'sample count', finite(root.subproblem_size, 'root sample size', 0));
        this.gamma = finite(meta.gamma, 'leaf penalty', typeof meta.lambda_reg === 'number' && this.n ? this.regression ? meta.lambda_reg * this.n : Math.round(meta.lambda_reg * this.n) : -1);
        this.eta = finite(meta.eta_defer, 'abstention cost', 0);
        this.accuracy = this.n > 0 && this.gamma >= 0;
        this.forbidden = new Set(constraints.forbiddenInternalFeatures ?? []);
        this.abstention = Boolean(meta.use_deferral);
        if (data) {
            if (!data.y.length || data.X.length !== data.y.length || this.n && this.n !== data.y.length)
                throw new Error('Dataset row count does not match the graph.');
            if (this.gamma < 0)
                throw new Error('Graph metadata needs gamma or lambda_reg to verify the dataset.');
            if (data.X.some(row => row.length !== data.feature_names.length || row.some(v => !Number.isFinite(v))) || data.y.some(v => !Number.isFinite(v)))
                throw new Error('Dataset contains invalid values.');
            for (const raw of (meta.featureRegistry as Registry[] ?? [])) {
                if (!Number.isSafeInteger(raw.internalFeature) || !Number.isSafeInteger(raw.originalFeature) || this.registry.has(raw.internalFeature) || data.feature_names[raw.originalFeature] !== raw.originalName || !Number.isFinite(raw.threshold))
                    throw new Error('Dataset feature names/order do not match graph featureRegistry.');
                this.registry.set(raw.internalFeature, raw);
            }
            this.masks = new Masks(data, this.registry);
        }
        this.report(0);
        this.root = this.context(graph.root_trie_id, partial, constraints.mode === 'sample', this.masks?.full ?? -1);
        if (!Number.isFinite(this.root.minimum))
            throw new Error('No completion satisfies the partial tree and constraints.');
        const queue = [this.root];
        this.root.budget = this.root.trie.budget ?? Infinity;
        for (let i = 0; i < queue.length; ++i) {
            const parent = queue[i];
            for (const alt of parent.alternatives)
                if ('split' in alt) {
                    const left = Math.min(alt.left.trie.budget ?? Infinity, parent.budget - alt.right.minimum), right = Math.min(alt.right.trie.budget ?? Infinity, parent.budget - alt.left.minimum);
                    if (left > alt.left.budget) {
                        alt.left.budget = left;
                        queue.push(alt.left);
                    }
                    if (right > alt.right.budget) {
                        alt.right.budget = right;
                        queue.push(alt.right);
                    }
                }
            this.check();
        }
        this.report(1);
        this.inside(this.root);
        if (!this.root.cells.length)
            throw new Error('No completion satisfies the partial tree, constraints and objective budget.');
    }
    private report(stage: number, completed_features = 0, feature_count = 0, current_feature = '') { this.progress?.({ stage, completed_features, feature_count, current_feature }); }
    private check() { if ((++this.ticks & 8191) === 0 && performance.now() - this.started > 300000)
        throw new Error('Graph analysis exceeded five minutes. Try a smaller objective budget or fix more of the partial tree.'); }
    private context(id: number, fixed: BuildNode | undefined, required: boolean, mask: number): Context {
        this.check();
        if (fixed?.kind === 'choice')
            fixed = undefined;
        const key = `${id}:${fixed?.uid ?? ''}:${required}`;
        if (this.active.has(id))
            throw new Error('Graph contains a cycle.');
        if (this.nodeMasks.has(id) && this.nodeMasks.get(id) !== mask)
            throw new Error('Shared graph node has inconsistent sample regions.');
        this.nodeMasks.set(id, mask);
        const cached = this.memo.get(key);
        if (cached)
            return cached;
        if (this.active.size > 512)
            throw new Error('Graph exceeds the supported depth.');
        const trie = this.tries.get(id);
        if (!trie)
            throw new Error('Graph references a missing trie node.');
        if (fixed && fixed.graphTrieId !== id)
            throw new Error('Partial tree does not match the graph.');
        if (trie.budget !== undefined)
            finite(trie.budget, 'node budget');
        if (this.masks && trie.subproblem_size !== undefined && trie.subproblem_size !== this.masks.size(mask))
            throw new Error('Dataset sample regions do not match the graph.');
        const ctx: Context = { id: this.contexts.length, trie, fixed, required, mask, minimum: Infinity, budget: -Infinity, alternatives: [], cells: [], byKey: new Map() };
        this.contexts.push(ctx);
        this.memo.set(key, ctx);
        this.active.add(id);
        for (const leafId of trie.leaf_ids) {
            const leaf = this.leaves.get(leafId);
            if (!leaf || leaf.parent_trie_id !== id)
                throw new Error('Graph contains an invalid leaf reference.');
            if (!Number.isFinite(leaf.prediction))
                throw new Error('Graph contains an invalid prediction.');
            const loss = finite(leaf.loss ?? leaf.objective, 'leaf loss');
            if (fixed?.kind === 'split' || fixed?.kind === 'leaf' && (fixed.leafId !== leafId || fixed.prediction !== leaf.prediction))
                continue;
            if (required && leaf.prediction !== this.constraints.targetPrediction)
                continue;
            if (!fits(loss, trie.budget ?? Infinity))
                continue;
            if (this.masks) {
                if (!this.regression && leaf.prediction !== -1 && (!Number.isSafeInteger(leaf.prediction) || leaf.prediction < 0 || leaf.prediction >= this.data!.class_names.length))
                    throw new Error('Dataset classes do not match graph predictions.');
                let error = 0;
                this.masks.rows(mask, row => { error += leaf.prediction === -1 && !this.regression ? this.eta : this.regression ? (this.data!.y[row] - leaf.prediction) ** 2 : Number(this.data!.y[row] !== leaf.prediction); });
                if (Math.abs((leaf.prediction === -1 && !this.regression ? Math.round(error) : error) + this.gamma - loss) > tolerance(loss))
                    throw new Error('Dataset labels or abstention cost do not match graph leaf losses.');
            }
            ctx.alternatives.push({ leaf });
            ctx.minimum = Math.min(ctx.minimum, loss);
        }
        for (const splitId of trie.split_ids) {
            const split = this.splits.get(splitId);
            if (!split || split.parent_trie_id !== id)
                throw new Error('Graph contains an invalid split reference.');
            if (fixed?.kind === 'leaf' || fixed?.kind === 'split' && (fixed.splitId !== splitId || fixed.feature !== split.feature) || this.forbidden.has(split.feature))
                continue;
            if (fixed && (!fixed.left || !fixed.right))
                throw new Error('Partial tree split has missing children.');
            const truth = this.constraints.featureTruth?.[String(split.feature)];
            const parts = this.masks?.split(mask, split.feature) ?? [-1, -1];
            const left = this.context(split.left_trie_id, fixed?.left, required && truth !== false, parts[0]);
            const right = this.context(split.right_trie_id, fixed?.right, required && truth !== true, parts[1]);
            if (fits(left.minimum + right.minimum, trie.budget ?? Infinity)) {
                ctx.alternatives.push({ split, left, right });
                ctx.minimum = Math.min(ctx.minimum, left.minimum + right.minimum);
            }
        }
        this.active.delete(id);
        return ctx;
    }
    private leafState(ctx: Context, leaf: LeafNode): Omit<Cell, 'count' | 'plan' | 'key'> {
        const cost = leaf.loss ?? leaf.objective!, abstain = !this.regression && leaf.prediction === -1;
        const size = leaf.subproblem_size ?? ctx.trie.subproblem_size;
        if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) throw new Error('Graph leaf sample sizes must be nonnegative integers.');
        if (abstain && size === undefined) {
            this.abstentionAvailable = false;
            if (this.constraints.maxAbstainedSamples !== undefined || this.constraints.minimizeAbstention) throw new Error('Graph leaf sample sizes are required for abstention caps or minimization.');
        }
        const error = abstain ? 0 : this.gamma < 0 ? 0 : cost - this.gamma;
        if (this.gamma < 0 || error < -tolerance(cost) || !this.regression && size !== undefined && error > size)
            this.accuracy = false;
        this.abstention ||= abstain;
        return { cost, leaves: 1, abstained: abstain ? size ?? 0 : 0, error: Math.max(0, error) };
    }
    private allowed(cost: number, leaves: number, abstained: number, budget: number) { return fits(cost, budget) && leaves <= (this.constraints.maxLeaves ?? Infinity) && abstained <= (this.constraints.maxAbstainedSamples ?? Infinity); }
    private inside(ctx: Context): Cell[] {
        if (this.built.has(ctx))
            return ctx.cells;
        for (const alt of ctx.alternatives) {
            if ('leaf' in alt) {
                const state = this.leafState(ctx, alt.leaf);
                if (this.allowed(state.cost, 1, state.abstained, ctx.budget))
                    this.add(ctx, state, 1n, { leaf: alt.leaf, trie: ctx.trie.id, fixed: ctx.fixed });
            }
            else {
                const left = this.inside(alt.left), right = this.inside(alt.right);
                for (const a of left)
                    for (const b of right) {
                        this.check();
                        const cost = a.cost + b.cost;
                        if (!fits(cost, ctx.budget))
                            break;
                        const state = { cost, leaves: a.leaves + b.leaves, abstained: a.abstained + b.abstained, error: a.error + b.error };
                        if (this.allowed(cost, state.leaves, state.abstained, ctx.budget))
                            this.add(ctx, state, a.count * b.count, { split: alt.split, left: a.plan, right: b.plan, trie: ctx.trie.id, fixed: ctx.fixed });
                    }
            }
        }
        ctx.cells = [...ctx.byKey.values()].sort((a, b) => a.cost - b.cost);
        this.order.push(ctx);
        this.built.add(ctx);
        return ctx.cells;
    }
    private add(ctx: Context, state: Omit<Cell, 'count' | 'plan' | 'key'>, count: bigint, plan: Plan) {
        const key = stateKey(state.cost, state.leaves, state.abstained, state.error), existing = ctx.byKey.get(key);
        if (existing)
            existing.count += count;
        else
            ctx.byKey.set(key, { ...state, key, count, plan });
    }
    private sumKey(a: Cell, b: Cell) { return stateKey(a.cost + b.cost, a.leaves + b.leaves, a.abstained + b.abstained, a.error + b.error); }
    private labels(mask: number): number[] {
        let result = this.histogram.get(mask);
        if (!result) {
            result = Array(this.data!.class_names.length).fill(0);
            this.masks!.rows(mask, row => ++result![this.data!.y[row]]);
            this.histogram.set(mask, result);
        }
        return result;
    }
    complete(nextUid: number): {
        tree: BuildNode;
        nextUid: number;
    } {
        const sorted = [...this.root.cells].sort((a, b) => this.constraints.minimizeAbstention ? a.abstained - b.abstained || a.cost - b.cost || a.leaves - b.leaves : a.cost - b.cost || a.abstained - b.abstained || a.leaves - b.leaves);
        const emit = (plan: Plan, fixed?: BuildNode): BuildNode => {
            const uid = fixed?.uid ?? nextUid++;
            if (plan.leaf)
                return { uid, graphTrieId: plan.trie, kind: 'leaf', leafId: plan.leaf.id, prediction: plan.leaf.prediction };
            return { uid, graphTrieId: plan.trie, kind: 'split', splitId: plan.split!.id, feature: plan.split!.feature, left: emit(plan.left!, fixed?.kind === 'split' ? fixed.left : undefined), right: emit(plan.right!, fixed?.kind === 'split' ? fixed.right : undefined) };
        };
        const tree = emit(sorted[0].plan, this.partial);
        return { tree, nextUid };
    }
    analyze(): AnalysisResult {
        const total = this.root.cells.reduce((sum, cell) => sum + cell.count, 0n), leaves = new Map<number, bigint>(), abstained = new Map<number, bigint>(), objectives = new Map<number, bigint>();
        let low = Infinity, high = -Infinity, undefinedCount = 0n, minMse = Infinity, maxMse = -Infinity;
        for (const cell of this.root.cells) {
            for (const [hist, value] of [[leaves, cell.leaves], [abstained, cell.abstained], [objectives, cell.cost]] as const)
                hist.set(value, (hist.get(value) ?? 0n) + cell.count);
            if (cell.abstained > this.n || !this.regression && cell.error > this.n - cell.abstained + tolerance(this.n)) this.accuracy = false;
            const predicted = this.n - cell.abstained;
            if (predicted > 0) {
                const value = 1 - cell.error / predicted;
                low = Math.min(low, value);
                high = Math.max(high, value);
            }
            else
                undefinedCount += cell.count;
            minMse = Math.min(minMse, cell.error / this.n);
            maxMse = Math.max(maxMse, cell.error / this.n);
        }
        const histogram = (hist: Map<number, bigint>) => [...hist].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count: String(count), probability: countFraction(count, total) }));
        const result: AnalysisResult = { task: this.regression ? 'regression' : 'classification', session_id: '', checkpoint: 0, tree_count: String(total), sample_count: this.n,
            exact: true, leaf_distribution: histogram(leaves), abstention_distribution: this.abstentionAvailable && this.n ? histogram(abstained) : [], objective_distribution: histogram(objectives),
            abstention_enabled: this.abstention, accuracy_available: this.accuracy && this.abstentionAvailable && !this.regression, abstention_available: this.abstentionAvailable,
            accuracy: { min: this.accuracy && this.abstentionAvailable && !this.regression && low <= high ? low : null, max: this.accuracy && this.abstentionAvailable && !this.regression && low <= high ? high : null, undefined_count: String(undefinedCount) },
            importance: [], disagreement: [], prediction_labels: [], class_count: this.data?.class_names.length ?? 0, timings: { total_seconds: 0 } };
        if (this.regression && this.accuracy)
            result.mse = { min: minMse, max: maxMse };
        if (!this.data)
            result.unavailable_reason = 'Permutation importance and sample disagreement require the original training dataset, which is not included in this graph.';
        else {
            this.report(2);
            if (!this.regression)
                result.disagreement = this.predictions(total);
            result.prediction_labels = [...this.data.class_names, 'Abstain'];
            const used = new Set<number>();
            for (const ctx of this.order)
                for (const alt of ctx.alternatives)
                    if ('split' in alt)
                        used.add(this.registry.get(alt.split.feature)!.originalFeature);
            for (let feature = 0; feature < this.data.feature_names.length; ++feature) {
                this.report(3, feature, this.data.feature_names.length, this.data.feature_names[feature]);
                let min = 0, max = 0;
                if (used.has(feature)) {
                    const ranges = this.importance(this.root, this.masks!.full, this.masks!.full, feature, new Map());
                    min = Infinity;
                    max = -Infinity;
                    for (const range of ranges) {
                        min = Math.min(min, range.min / this.n);
                        max = Math.max(max, range.max / this.n);
                    }
                }
                result.importance.push({ name: this.data.feature_names[feature], min, max });
            }
        }
        this.report(4);
        result.timings.total_seconds = (performance.now() - this.started) / 1000;
        return result;
    }
    private predictions(total: bigint): AnalysisResult['disagreement'] {
        const predictions: bigint[][] = Array.from({ length: this.data!.y.length }, () => Array<bigint>(this.data!.class_names.length + 1).fill(0n));
        const outside = new Map<Context, Map<string, bigint>>([[this.root, new Map(this.root.cells.map(cell => [cell.key, 1n]))]]);
        for (const ctx of [...this.order].reverse()) {
            const weights = outside.get(ctx);
            if (!weights)
                continue;
            for (const alt of ctx.alternatives) {
                if ('leaf' in alt) {
                    const s = this.leafState(ctx, alt.leaf), weight = weights.get(stateKey(s.cost, s.leaves, s.abstained, s.error));
                    if (weight)
                        this.masks!.rows(ctx.mask, row => { predictions[row][alt.leaf.prediction === -1 ? this.data!.class_names.length : alt.leaf.prediction] += weight; });
                }
                else {
                    if (!outside.has(alt.left))
                        outside.set(alt.left, new Map());
                    if (!outside.has(alt.right))
                        outside.set(alt.right, new Map());
                    const lw = outside.get(alt.left)!, rw = outside.get(alt.right)!;
                    for (const a of alt.left.cells)
                        for (const b of alt.right.cells) {
                            this.check();
                            if (!fits(a.cost + b.cost, ctx.budget))
                                break;
                            const weight = weights.get(this.sumKey(a, b));
                            if (!weight)
                                continue;
                            lw.set(a.key, (lw.get(a.key) ?? 0n) + weight * b.count);
                            rw.set(b.key, (rw.get(b.key) ?? 0n) + weight * a.count);
                        }
                }
            }
        }
        return predictions.map((counts, row) => { const probabilities = counts.map(count => countFraction(count, total)); return { row: row + 1, counts: counts.map(String), probabilities, disagreement: Math.max(0, 1 - Math.max(...probabilities)) }; });
    }
    private importance(ctx: Context, recipient: number, donor: number, feature: number, memo: Map<string, Range[]>): Range[] {
        this.check();
        const key = `${ctx.id}:${recipient}:${donor}`, cached = memo.get(key);
        if (cached)
            return cached;
        const recipientN = this.masks!.size(recipient), donorN = this.masks!.size(donor), output = new Map<string, Range>();
        if (!recipientN || !donorN) {
            const ranges = ctx.cells.map(cell => ({ cell, min: -cell.error - this.eta * cell.abstained, max: -cell.error - this.eta * cell.abstained }));
            memo.set(key, ranges);
            return ranges;
        }
        const extend = (cell: Cell, min: number, max: number) => {
            const previous = output.get(cell.key);
            if (previous) {
                previous.min = Math.min(previous.min, min);
                previous.max = Math.max(previous.max, max);
            }
            else
                output.set(cell.key, { cell, min, max });
        };
        for (const alt of ctx.alternatives) {
            if ('leaf' in alt) {
                const state = this.leafState(ctx, alt.leaf), cell = ctx.byKey.get(stateKey(state.cost, state.leaves, state.abstained, state.error));
                if (!cell)
                    continue;
                let changed = 0;
                if (this.regression)
                    this.masks!.rows(recipient, row => { changed += (this.data!.y[row] - alt.leaf.prediction) ** 2; });
                else
                    changed = alt.leaf.prediction === -1 ? this.eta * recipientN : recipientN - (this.labels(recipient)[alt.leaf.prediction] ?? 0);
                const delta = changed * donorN / this.n - state.error - this.eta * state.abstained;
                extend(cell, delta, delta);
            }
            else {
                let lr = recipient, rr = recipient, ld = donor, rd = donor;
                if (this.registry.get(alt.split.feature)!.originalFeature === feature)
                    [ld, rd] = this.masks!.split(donor, alt.split.feature);
                else
                    [lr, rr] = this.masks!.split(recipient, alt.split.feature);
                const left = this.importance(alt.left, lr, ld, feature, memo), right = this.importance(alt.right, rr, rd, feature, memo);
                for (const a of left)
                    for (const b of right) {
                        this.check();
                        if (!fits(a.cell.cost + b.cell.cost, ctx.budget))
                            break;
                        const cell = ctx.byKey.get(this.sumKey(a.cell, b.cell));
                        if (cell)
                            extend(cell, a.min + b.min, a.max + b.max);
                    }
            }
        }
        const result = [...output.values()].sort((a, b) => a.cell.cost - b.cell.cost);
        memo.set(key, result);
        return result;
    }
}
export function analyzeGraph(graph: AndOrGraph, meta: Record<string, unknown>, partial: BuildNode, dataset?: Dataset, progress?: (p: AnalysisProgress) => void): AnalysisResult {
    return new Profiles(graph, meta, partial, dataset, {}, progress).analyze();
}
export function completeGraph(graph: AndOrGraph, meta: Record<string, unknown>, partial: BuildNode, nextUid: number, constraint: GraphConstraint = {}) {
    for (const [value, min] of [[constraint.maxLeaves, 1], [constraint.maxAbstainedSamples, 0]] as const)
        if (value !== undefined && (!Number.isSafeInteger(value) || value < min))
            throw new Error('Completion caps must be nonnegative integers.');
    return new Profiles(graph, meta, partial, undefined, constraint).complete(nextUid);
}
