import { DEFAULT_TRAINING_SETTINGS, type TrainingSettings } from './trainingSettings';

type Key = keyof TrainingSettings;
export function TrainingFields({ value: s, onChange }: { value: TrainingSettings; onChange: (settings: TrainingSettings) => void }) {
  const change = (key: Key, value: TrainingSettings[Key]) => {
    const next = { ...s, [key]: value };
    if (key === 'depth_budget') next.lookahead_k = Math.min(Number(value), Number.isFinite(s.lookahead_k) ? s.lookahead_k : 1);
    if (key === 'rashomon_mult') next.second_rashomon_mult = Math.max(s.second_rashomon_mult, Number(value));
    onChange(next);
  };
  const number = (key: Key, label: string, help?: string, min = 0, max?: number, step: string | number = 'any') => <label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={Number.isFinite(Number(s[key])) ? Number(s[key]) : ''} onChange={e => change(key, e.target.valueAsNumber)}/>{help && <small>{help}</small>}</label>;
  const select = (key: Key, label: string, choices: [string, string][], help?: string) => <label key={key}>{label}<select aria-label={label} value={String(s[key])} onChange={e => change(key, e.target.value)}>{choices.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select>{help && <small>{help}</small>}</label>;
  const mode = (key: Key, label: string, choices: string[]) => <label key={key}>{label}<select aria-label={label} value={Number(s[key])} onChange={e => change(key, Number(e.target.value))}>{choices.map((text, value) => <option key={value} value={value}>{text}</option>)}</select></label>;
  const toggle = (key: Key, label: string, help: string) => <label key={key} className="training-toggle"><input aria-label={label} type="checkbox" checked={Boolean(s[key])} onChange={e => change(key, e.target.checked)}/><span>{label}<small>{help}</small></span></label>;
  const continuous = (key: Key, label: string) => <label key={key}>{label}<select aria-label={label} value={s[key] === null ? 'auto' : String(s[key])} onChange={e => change(key, e.target.value === 'auto' ? null : e.target.value === 'true')}><option value="auto">Follow proxy mode</option><option value="false">Binarized</option><option value="true">Continuous</option></select></label>;
  return <>
    <div className="live-fields">
      {number('lambda_reg', 'Leaf penalty', 'Penalty per leaf, scaled by the training sample count.', 0, undefined, .001)}
      {number('depth_budget', 'Maximum depth', undefined, 0, 127, 1)}
      {number('rashomon_mult', 'Rashomon multiplier')}
      {number('second_rashomon_mult', 'Expand multiplier to')}
      {number('runtime_limit_seconds', 'Runtime limit (seconds)', '-1 for unlimited. Limits apply after the initial restricted solve.', -1)}
      {number('memory_limit_mb', 'Memory limit (MB)', '-1 for unlimited.', -1)}
      {select('proxy_mode', 'Proxy mode', [['binarized', 'Binarized'], ['hybrid', 'Hybrid'], ['continuous', 'Continuous']])}
    </div>
    <details className="training-advanced">
      <summary>Advanced training settings</summary>
      <div className="training-abstain">
        {toggle('allow_abstain', 'Allow Abstain leaves', 'Abstain uses the exact target label for each training sample instead of a single class prediction. It does not learn labels for unseen data.')}
        {s.allow_abstain && number('abstain_cost', 'Abstention cost', 'Cost per abstained sample, in addition to the leaf penalty. Zero makes full abstention optimal when feasible.')}
      </div>
      <h3>Objective and search</h3>
      <div className="live-fields">
        {number('lookahead_k', 'Lookahead depth', 'Higher values improve the initial proxy at greater search cost.', 0, s.depth_budget, 1)}
        {select('key_mode', 'Subproblem identity', [['hash', '64-bit hash'], ['hash128', '128-bit hash'], ['exact', 'Exact bitvectors'], ['lits_exact', 'Exact literal sets']])}
        <label>Proxy search style<select aria-label="Proxy search style" value={s.proxy_style} onChange={e => change('proxy_style', Number(e.target.value))}><option value={0}>Recursive best split</option><option value={1}>Block split</option><option value={3}>Split without postprocessing</option></select></label>
        {mode('greedy_split_mode', 'Greedy split criterion', ['Entropy', 'Entropy with exact depth-one solve', 'Child leaf objective'])}
        {select('greedy_continuous_mode', 'Greedy feature evaluation', [['binary', 'Binarized thresholds'], ['numerical', 'Numerical features']])}
        {number('multiplicative_slack', 'Extra multiplicative slack', 'Additional slack applied to objective bounds.')}
      </div>
      <div className="training-toggles">
        {toggle('additive', 'Additive Rashomon tolerance', 'Interpret each multiplier as extra objective per sample instead of a relative increase.')}
        {toggle('rule_list_mode', 'Guarantee rule-list recovery', 'Ensure rule lists are recovered within the objective bound, alongside other tree structures.')}
        {toggle('majority_leaf_only', 'Majority class leaves only', 'Exclude ordinary non-majority class leaves; Abstain remains a separate action.')}
        {toggle('use_multipass', 'Multipass search', 'Use repeated passes during the native search.')}
        {toggle('stronger_rollout', 'Stronger rollout', 'Spend additional work improving rollout bounds.')}
        {toggle('evaluated_use_min_objectives', 'Reuse minimum objectives', 'Use known minimum objectives for evaluated subproblems.')}
      </div>
      <h3>Refinement and thresholds</h3>
      <div className="live-fields">
        {number('multiplier_step_size', 'Multiplier expansion step', undefined, 0)}
        {number('refinement_width', 'Refinement width', 'Number of threshold refinements selected per round.', 1, undefined, 1)}
        {number('max_refinement_rounds', 'Maximum refinement rounds', '-1 for unlimited; 0 skips threshold refinement.', -1, undefined, 1)}
        {number('max_number_thresholds_per_feature', 'Threshold cap per feature', '-1 keeps all thresholds. A cap restricts the search space.', -1, undefined, 1)}
        {select('proxy_refinement', 'Proxy refinement', [['auto', 'Automatic'], ['on', 'On'], ['off', 'Off']])}
        {continuous('continuous_proxy_in_lickety', 'Lickety proxy evaluation')}
        {continuous('continuous_proxy_in_depthd_exact', 'Exact depth proxy evaluation')}
        {continuous('continuous_proxy_in_greedy', 'Greedy proxy evaluation')}
        {(['proxy_threshold_features', 'initial_active_threshold_features'] as const).map(key => <label key={key}>{key === 'proxy_threshold_features' ? 'Proxy threshold IDs' : 'Initial active threshold IDs'}<input aria-label={key === 'proxy_threshold_features' ? 'Proxy threshold IDs' : 'Initial active threshold IDs'} value={s[key]} placeholder="Automatic" onChange={e => change(key, e.target.value)}/><small>Optional comma-separated internal threshold IDs after preprocessing. Blank uses automatic selection.</small></label>)}
      </div>
      <h3>Caching</h3>
      <div className="training-toggles">
        {toggle('trie_cache', 'Cache graph subproblems', 'Reuse native trie nodes across matching subproblems.')}
        {toggle('cache_cheap_subproblems', 'Cache cheap subproblems', 'Also cache inexpensive proxy evaluations. Proxy objective caching is always enabled by the anytime engine.')}
      </div>
      <button className="ghost-button" type="button" onClick={() => onChange({ ...DEFAULT_TRAINING_SETTINGS })}>Reset training settings</button>
    </details>
  </>;
}
