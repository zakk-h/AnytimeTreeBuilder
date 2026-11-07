import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, Download, X } from 'lucide-react';
import { nativeApi } from './nativeGraph';
import type { BuildNode } from './types';
import './nativeAnalysis.css';

type Bin = { value: number; count: string; probability: number };
type Progress = { stage: number; completed_features: number; feature_count: number; current_feature: string };
const analysisStages = ['Checking feasible completions', 'Counting completions', 'Computing prediction disagreement', 'Computing feature importance'];
const completedStages = ['', 'Checked feasible completions.', 'Computed completion counts.', 'Computed counts, accuracy ranges, distributions, and disagreement.'];
type Result = {
  session_id: string; checkpoint: number; tree_count: string; sample_count: number; exact: boolean;
  leaf_distribution: Bin[]; abstention_distribution: Bin[];
  accuracy: { min: number | null; max: number | null; undefined_count: string };
  importance: { name: string; min: number; max: number }[];
  disagreement: { row: number; counts: string[]; probabilities: number[]; disagreement: number }[];
  prediction_labels: string[]; class_count: number; abstention_enabled: boolean;
};
const percent = (n: number) => `${(100 * n).toFixed(2).replace(/\.?0+$/, '')}%`;
const countLabel = (n: string) => n.length > 12 ? `${n[0]}.${n.slice(1, 3)} × 10^${n.length - 1}` : Number(n).toLocaleString();
const exactCount = (n: string) => BigInt(n).toLocaleString();
function Distribution({ bins, abstention = false, sampleCount }: { bins: Bin[]; abstention?: boolean; sampleCount: number }) {
  const [hovered, setHovered] = useState<Bin | null>(null);
  const min = bins[0]?.value ?? 0, max = bins[bins.length - 1]?.value ?? 0;
  const width = 480 / Math.max(1, max - min + 1);
  const peak = Math.max(...bins.map(b => b.probability), 1e-12);
  const scale = 10 ** Math.floor(Math.log10(peak));
  const top = Math.min(1, [1, 2, 5, 10].find(n => n * scale >= peak)! * scale);
  const x = (value: number) => 80 + (value - min + .5) * width;
  const valueLabel = (value: number) => abstention ? percent(value / sampleCount) : value.toLocaleString();
  const label = abstention ? 'Proportion abstained' : 'Leaves';
  const describe = (bin: Bin) => `${valueLabel(bin.value)} ${abstention ? 'abstained' : 'leaves'} · ${exactCount(bin.count)} models · ${percent(bin.probability)} of models`;
  const tickCount = Math.min(5, max - min + 1);
  const ticks = [...new Set(Array.from({ length: tickCount }, (_, i) => Math.round(min + (max - min) * i / Math.max(1, tickCount - 1))))];
  return <div className={`analysis-chart analysis-distribution-${abstention ? 'abstention' : 'leaves'}`}>
    <svg viewBox="0 0 600 250" role="group" aria-label={`${label}: distribution over models`} onMouseLeave={() => setHovered(null)} onMouseMove={e => {
      if (!bins.length) return;
      const bounds = e.currentTarget.getBoundingClientRect(), px = (e.clientX - bounds.left) * 600 / bounds.width;
      setHovered(bins.reduce((best, bin) => Math.abs(x(bin.value) - px) < Math.abs(x(best.value) - px) ? bin : best));
    }}>
      <text x="80" y="17">Proportion of models</text>
      {[0, .25, .5, .75, 1].map(t => <g key={t}><line x1="80" x2="560" y1={190 - 150 * t} y2={190 - 150 * t} stroke="currentColor" opacity=".12"/><text x="70" y={194 - 150 * t} textAnchor="end">{percent(t * top)}</text></g>)}
      {bins.map(bin => <rect key={bin.value} tabIndex={0} role="img" aria-label={describe(bin)} onFocus={() => setHovered(bin)} onBlur={() => setHovered(null)} x={x(bin.value) - width * .425} y={190 - 150 * bin.probability / top} width={Math.max(.5, width * .85)} height={150 * bin.probability / top} rx="2"><title>{describe(bin)}</title></rect>)}
      {ticks.map(t => <text key={t} x={x(t)} y="212" textAnchor="middle">{valueLabel(t)}</text>)}
      <text x="320" y="240" textAnchor="middle">{label}</text>
    </svg>
    {hovered && <div className="analysis-chart-tooltip" role="tooltip">{describe(hovered)}</div>}

  </div>;
}
function Violin({ values, outcomes }: { values: number[]; outcomes: number }) {
  const limit = Math.max(.5, 1 - 1 / outcomes);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  const bandwidth = Math.max(.025, Math.min(.12, .9 * deviation * values.length ** -.2));
  const density = Array.from({ length: 81 }, (_, i) => ({ y: limit * i / 80, d: values.reduce((a, v) => a + Math.exp(-.5 * ((limit * i / 80 - v) / bandwidth) ** 2), 0) }));
  const peak = Math.max(...density.map(p => p.d), 1);
  const coords = (reverse: boolean) => (reverse ? [...density].reverse() : density).map(p => `${150 + (reverse ? -1 : 1) * 75 * p.d / peak},${245 - p.y / limit * 220}`).join(' L');
  return <svg className="analysis-violin" viewBox="0 0 300 280" role="img" aria-label="Distribution of sample disagreement across completions">
    {[0, .25, .5, .75, 1].map(t => <g key={t}><line x1="65" x2="275" y1={245 - 220 * t} y2={245 - 220 * t} stroke="currentColor" opacity=".12"/><text x="60" y={249 - 220 * t} textAnchor="end">{percent(t * limit)}</text></g>)}
    {deviation < 1e-12 ? <line x1="100" x2="200" y1={245 - 220 * mean / limit} y2={245 - 220 * mean / limit} stroke="#477daf" strokeWidth="5"/> : <path d={`M${coords(false)} L${coords(true)} Z`} fill="#83afd9" fillOpacity=".6" stroke="#477daf"/>}
    <text x="150" y="273" textAnchor="middle">Sample disagreement</text>
  </svg>;
}
export function NativeAnalysis({ session, tree, disabled, onBusyChange }: { session: string; tree: BuildNode; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const [open, setOpen] = useState(false), [result, setResult] = useState<Result | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [progress, setProgress] = useState<Progress | null>(null);
  const request = useRef<AbortController | null>(null), token = useRef(''), modal = useRef<HTMLElement>(null), previousFocus = useRef<HTMLElement | null>(null);
  const cancel = () => {
    request.current?.abort(); request.current = null;
    if (token.current) { void nativeApi('cancel-query', session, { token: token.current }).catch(() => {}); token.current = ''; }
    setBusy(false);
  };
  const close = () => { cancel(); setOpen(false); previousFocus.current?.focus(); };
  useEffect(() => { cancel(); setOpen(false); setResult(null); return cancel; }, [session, tree]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { if (open) modal.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [open]);
  const run = async () => {
    cancel(); const controller = new AbortController(); request.current = controller; token.current = crypto.randomUUID();
    setBusy(true); setError(''); setResult(null); setProgress(null);
    const analysisToken = token.current;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await nativeApi<Progress>('analysis-progress', session, { token: analysisToken }, controller.signal);
        if (!controller.signal.aborted) setProgress(next);
      } catch { /* The analysis request itself reports connection or computation errors. */ }
      if (!controller.signal.aborted) pollTimer = setTimeout(poll, 400);
    };
    pollTimer = setTimeout(poll, 150);
    try {
      const response = await nativeApi<Result>('analyze', session, { tree, analysis_token: token.current }, controller.signal);
      if (!controller.signal.aborted) setResult(response);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { controller.abort(); clearTimeout(pollTimer); if (request.current === controller) { setBusy(false); request.current = null; token.current = ''; } }
  };
  return <><button className="ghost-button" disabled={disabled} title={disabled ? 'Open a dataset session to analyze its native graph' : 'Analyze completions of the whole current partial tree'} onClick={() => { previousFocus.current = document.activeElement as HTMLElement; setOpen(true); void run(); }}><BarChart3 size={16}/> Analyze</button>
    {open && createPortal(<div className="analysis-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <section className="analysis-dialog" ref={modal} role="dialog" aria-modal="true" aria-labelledby="analysis-title" onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        if (e.key === 'Tab') {
          const controls = [...modal.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, summary, [tabindex="0"]')].filter(el => el.getClientRects().length);
          const first = controls[0], last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
        <header><div><h2 id="analysis-title">Analyze partial tree</h2></div><button className="ghost-button" aria-label="Close analysis" onClick={close}><X size={20}/></button></header>
        {busy && <button className="ghost-button" onClick={close}>Cancel analysis</button>}
        {busy && <div className="analysis-progress" role="status" aria-live="polite">
          <p>Calculating…</p>
          <progress aria-label="Analysis stages completed" max={4} value={Math.max(0, progress?.stage ?? 0) + (progress?.stage === 3 && progress.feature_count ? progress.completed_features / progress.feature_count : 0)}/>
          {progress && progress.stage >= 0 && progress.stage < 4 && <>
            {completedStages[progress.stage] && <small>{completedStages[progress.stage]}</small>}
            <span>{analysisStages[progress.stage]}{progress.stage === 3 && progress.feature_count > 0 && ` · ${progress.completed_features}/${progress.feature_count} features complete`}{progress.current_feature && ` · ${progress.current_feature}`}</span>
          </>}
        </div>}
        {error && <><p role="alert" className="upload-error">{error}</p><button className="primary-button" onClick={() => void run()}>Retry analysis</button></>}
        {result && <>
          <div className="analysis-metrics"><div><span>Feasible completions</span><b title={result.tree_count}>{countLabel(result.tree_count)}</b></div><div><span>Accuracy on predicted samples</span><b>{result.accuracy.min === null ? '—' : `${percent(result.accuracy.min)} – ${percent(result.accuracy.max!)}`}</b></div><div><span>Number of leaves</span><b>{result.leaf_distribution[0]?.value.toLocaleString()} – {result.leaf_distribution[result.leaf_distribution.length - 1]?.value.toLocaleString()}</b></div></div>
          {result.accuracy.undefined_count !== '0' && <p className="analysis-note">{countLabel(result.accuracy.undefined_count)} completions abstain on every sample and have undefined accuracy.</p>}
          <section><h3>Feature importance ranges</h3><p>Expected increase in loss over all permutations of one dataset feature. Min/max over tree completions in the Rashomon set.</p>
            <table className="analysis-importance"><thead><tr><th>Feature</th><th>Minimum (<abbr title="Percentage points">pp</abbr>)</th><th>Maximum (<abbr title="Percentage points">pp</abbr>)</th></tr></thead><tbody>{result.importance.map((f, i) => <tr key={i}><td>{f.name}</td><td>{(100 * f.min).toFixed(3)}</td><td>{(100 * f.max).toFixed(3)}</td></tr>)}</tbody></table>
          </section>
          <div className={`analysis-grid ${result.abstention_enabled ? '' : 'analysis-grid-single'}`}><section><h3>Leaves</h3><Distribution bins={result.leaf_distribution} sampleCount={result.sample_count}/></section>{result.abstention_enabled && <section><h3>Proportion abstained</h3><Distribution bins={result.abstention_distribution} abstention sampleCount={result.sample_count}/></section>}</div>
          <section><h3>Prediction disagreement across samples</h3>{(result.class_count > 2 || result.abstention_enabled) && <p>{result.class_count > 2 && 'For each sample, the proportion of models differing from the most common prediction. '}{result.abstention_enabled && 'Abstain counts as a separate prediction.'}</p>}<Violin values={result.disagreement.map(row => row.disagreement)} outcomes={result.class_count + (result.abstention_enabled ? 1 : 0)}/></section>
          <button className="ghost-button" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'partial-tree-analysis.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download size={16}/> Export analysis</button>
        </>}
      </section>
    </div>, document.body)}
  </>;
}
