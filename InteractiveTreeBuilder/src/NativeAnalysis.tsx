import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, Download, X } from 'lucide-react';
import { nativeApi } from './nativeGraph';
import type { BuildNode } from './types';
import './nativeAnalysis.css';

type Bin = { value: number; count: string; probability: number };
type Result = {
  session_id: string; checkpoint: number; tree_count: string; sample_count: number; exact: boolean;
  leaf_distribution: Bin[]; abstention_distribution: Bin[];
  accuracy: { min: number | null; max: number | null; undefined_count: string };
  importance: { name: string; min: number; max: number }[];
  disagreement: { row: number; counts: string[]; probabilities: number[]; disagreement: number }[];
  prediction_labels: string[];
};
const percent = (n: number) => `${(100 * n).toFixed(2).replace(/\.?0+$/, '')}%`;
const countLabel = (n: string) => n.length > 12 ? `${n[0]}.${n.slice(1, 3)} × 10^${n.length - 1}` : Number(n).toLocaleString();
function Distribution({ bins, label }: { bins: Bin[]; label: string }) {
  const min = bins[0]?.value ?? 0, max = bins[bins.length - 1]?.value ?? 0;
  const width = 520 / Math.max(1, max - min + 1), peak = Math.max(...bins.map(b => b.probability), 1e-12);
  return <div className="analysis-chart"><svg viewBox="0 0 580 180" role="img" aria-label={label}>
    <line x1="30" x2="550" y1="145" y2="145" stroke="currentColor" opacity=".2"/>
    {bins.map(bin => <rect key={bin.value} x={30 + (bin.value - min) * width} y={145 - 120 * bin.probability / peak} width={Math.max(.5, width * .85)} height={120 * bin.probability / peak} rx="2"><title>{bin.value}: {percent(bin.probability)} · {bin.count} trees</title></rect>)}
    <text x="30" y="170">{min}</text><text x="550" y="170" textAnchor="end">{max}</text>
  </svg><details><summary>Exact counts</summary><table><thead><tr><th>{label}</th><th>Trees</th><th>Share</th></tr></thead><tbody>{bins.map(b => <tr key={b.value}><td>{b.value}</td><td>{b.count}</td><td>{percent(b.probability)}</td></tr>)}</tbody></table></details></div>;
}
function Violin({ values }: { values: number[] }) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  const bandwidth = Math.max(.025, Math.min(.12, .9 * deviation * values.length ** -.2));
  const density = Array.from({ length: 81 }, (_, i) => ({ y: i / 80, d: values.reduce((a, v) => a + Math.exp(-.5 * ((i / 80 - v) / bandwidth) ** 2), 0) }));
  const peak = Math.max(...density.map(p => p.d), 1);
  const coords = (reverse: boolean) => (reverse ? [...density].reverse() : density).map(p => `${150 + (reverse ? -1 : 1) * 75 * p.d / peak},${245 - p.y * 220}`).join(' L');
  return <svg className="analysis-violin" viewBox="0 0 300 280" role="img" aria-label="Distribution of sample disagreement across completions">
    {[0, .25, .5, .75, 1].map(t => <g key={t}><line x1="45" x2="255" y1={245 - 220 * t} y2={245 - 220 * t} stroke="currentColor" opacity=".12"/><text x="38" y={249 - 220 * t} textAnchor="end">{t}</text></g>)}
    {deviation < 1e-12 ? <line x1="100" x2="200" y1={245 - 220 * mean} y2={245 - 220 * mean} stroke="#477daf" strokeWidth="5"/> : <path d={`M${coords(false)} L${coords(true)} Z`} fill="#83afd9" fillOpacity=".6" stroke="#477daf"/>}
    <text x="150" y="273" textAnchor="middle">Sample disagreement</text>
  </svg>;
}
export function NativeAnalysis({ session, tree, disabled, onBusyChange }: { session: string; tree: BuildNode; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const [open, setOpen] = useState(false), [result, setResult] = useState<Result | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await nativeApi<Result>('analyze', session, { tree, analysis_token: token.current }, controller.signal);
      if (!controller.signal.aborted) setResult(response);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (request.current === controller) { setBusy(false); request.current = null; token.current = ''; } }
  };
  return <><button className="ghost-button" disabled={disabled} title={disabled ? 'Open a dataset session to analyze its native graph' : 'Analyze completions of the whole current partial tree'} onClick={() => { previousFocus.current = document.activeElement as HTMLElement; setOpen(true); void run(); }}><BarChart3 size={16}/> Analyze</button>
    {open && createPortal(<div className="analysis-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <section className="analysis-dialog" ref={modal} role="dialog" aria-modal="true" aria-labelledby="analysis-title" onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        if (e.key === 'Tab') {
          const controls = [...modal.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, summary')].filter(el => el.getClientRects().length);
          const first = controls[0], last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
        <header><div><h2 id="analysis-title">Analyze partial tree</h2><p>All represented completions of the whole current tree, preserving your selected splits and leaves.</p></div><button className="ghost-button" aria-label="Close analysis" onClick={close}><X size={20}/></button></header>
        {busy && <button className="ghost-button" onClick={close}>Cancel analysis</button>}
        {busy && <p role="status">Calculating exact counts and all-permutation ranges. Enumeration pauses while analysis reads the graph.</p>}
        {error && <><p role="alert" className="upload-error">{error}</p><button className="primary-button" onClick={() => void run()}>Retry analysis</button></>}
        {result && <>
          <div className="analysis-metrics"><div><span>Feasible completions</span><b title={result.tree_count}>{countLabel(result.tree_count)}</b></div><div><span>Accuracy on predicted samples</span><b>{result.accuracy.min === null ? '—' : `${percent(result.accuracy.min)} – ${percent(result.accuracy.max!)}`}</b></div><div><span>Training samples</span><b>{result.sample_count.toLocaleString()}</b></div></div>
          <p className="analysis-note">Exact for the graph available when analysis began. Trees are weighted uniformly; no completed trees or permutations were sampled. {result.accuracy.undefined_count !== '0' && `${countLabel(result.accuracy.undefined_count)} completions abstain on every sample and have undefined accuracy.`}</p>
          <section><h3>Feature importance ranges</h3><p>Expected increase in loss over all permutations of one dataset feature, without refitting. Abstain contributes its configured cost; leaf penalties are excluded. Values are percentage points.</p>
            <table className="analysis-importance"><thead><tr><th>Feature</th><th>Minimum</th><th>Maximum</th></tr></thead><tbody>{result.importance.map((f, i) => <tr key={i}><td>{f.name}</td><td>{(100 * f.min).toFixed(3)}</td><td>{(100 * f.max).toFixed(3)}</td></tr>)}</tbody></table>
          </section>
          <div className="analysis-grid"><section><h3>Leaves per completed tree</h3><Distribution bins={result.leaf_distribution} label="Leaves"/></section><section><h3>Abstained samples per tree</h3><Distribution bins={result.abstention_distribution} label="Abstained samples"/></section></div>
          <section><h3>Prediction disagreement across samples</h3><p>For each training sample, the chance that two independent uniform completions disagree: 1 − Σ p(class)². Abstain is a separate outcome. The violin smooths the exact scores across samples.</p><Violin values={result.disagreement.map(row => row.disagreement)}/></section>
          <button className="ghost-button" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'partial-tree-analysis.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download size={16}/> Export analysis and sample class counts</button>
        </>}
      </section>
    </div>, document.body)}
  </>;
}
