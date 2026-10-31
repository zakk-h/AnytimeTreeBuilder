export const DEFAULT_TRAINING_SETTINGS = {
  lambda_reg: .005, depth_budget: 5, rashomon_mult: .01, second_rashomon_mult: .01,
  runtime_limit_seconds: 600, memory_limit_mb: 10000, proxy_mode: 'binarized',
  allow_abstain: false, abstain_cost: .1,
  lookahead_k: 1, multiplier_step_size: .0025, refinement_width: 1,
  max_refinement_rounds: -1, max_number_thresholds_per_feature: -1,
  proxy_refinement: 'auto', key_mode: 'hash', proxy_style: 0, greedy_split_mode: 0,
  greedy_continuous_mode: 'binary', use_multipass: true, rule_list_mode: false,
  majority_leaf_only: false, trie_cache: true, cache_cheap_subproblems: false,
  stronger_rollout: false, evaluated_use_min_objectives: false, additive: false,
  multiplicative_slack: 0, proxy_threshold_features: '', initial_active_threshold_features: '',
  continuous_proxy_in_lickety: null as boolean | null,
  continuous_proxy_in_depthd_exact: null as boolean | null,
  continuous_proxy_in_greedy: null as boolean | null,
};
export type TrainingSettings = typeof DEFAULT_TRAINING_SETTINGS;

export function thresholdIds(text: string): number[] {
  if (!text.trim()) return [];
  const parts = text.split(',').map(part => part.trim());
  if (parts.some(part => !/^\d+$/.test(part))) throw new Error('Threshold IDs must be comma-separated nonnegative integers.');
  const ids = parts.map(Number);
  if (ids.some(id => !Number.isSafeInteger(id) || id > 2147483647) || new Set(ids).size !== ids.length)
    throw new Error('Threshold IDs must be distinct integers in the engine range.');
  return ids;
}

export function trainingSettingsError(s: TrainingSettings): string | undefined {
  if (Object.values(s).some(value => typeof value === 'number' && !Number.isFinite(value))) return 'Fill in all numeric settings.';
  const integers = ['depth_budget', 'lookahead_k', 'refinement_width', 'max_refinement_rounds', 'max_number_thresholds_per_feature', 'proxy_style', 'greedy_split_mode'] as const;
  if (integers.some(key => !Number.isInteger(s[key]) || s[key] > 2147483647)) return 'Depth, lookahead, widths, rounds and threshold limits must be integers.';
  if (s.depth_budget < 0 || s.depth_budget > 127) return 'Maximum depth must be between 0 and 127.';
  if (s.lookahead_k < 0 || s.lookahead_k > s.depth_budget) return 'Lookahead must be between 0 and maximum depth.';
  if (s.lambda_reg < 0 || s.rashomon_mult < 0 || s.abstain_cost < 0 || s.multiplicative_slack < 0) return 'Penalties and tolerances must be nonnegative.';
  if (s.second_rashomon_mult < s.rashomon_mult) return 'The expanded tolerance must be at least the initial tolerance.';
  if (s.multiplier_step_size <= 0 || s.refinement_width < 1) return 'Expansion step and refinement width must be positive.';
  if ([s.runtime_limit_seconds, s.memory_limit_mb].some(value => value !== -1 && value <= 0)) return 'Resource limits must be positive, or -1 for unlimited.';
  if (s.max_refinement_rounds < -1 || (s.max_number_thresholds_per_feature !== -1 && s.max_number_thresholds_per_feature < 1)) return 'Use -1 for no round/threshold limit; otherwise use nonnegative rounds and positive threshold limits.';
  if (![0, 1, 3].includes(s.proxy_style) || ![0, 1, 2].includes(s.greedy_split_mode)) return 'Invalid proxy or greedy style.';
  try { thresholdIds(s.proxy_threshold_features); thresholdIds(s.initial_active_threshold_features); }
  catch (error) { return (error as Error).message; }
}
export function nativeTrainingSettings(s: TrainingSettings) {
  const error = trainingSettingsError(s);
  if (error) throw new Error(error);
  return { ...s, proxy_threshold_features: thresholdIds(s.proxy_threshold_features), initial_active_threshold_features: thresholdIds(s.initial_active_threshold_features) };
}
