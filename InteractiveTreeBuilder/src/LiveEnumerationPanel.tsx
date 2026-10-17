import { useEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Square, X } from 'lucide-react';
import type { ArborEnumBuilderMeta } from './arborenumPayload';
import './liveEnumeration.css';
import { parseCsv, toDataset } from './liveDataset';

type Status = {
  session_id: string; phase: string; error: string; stop_requested: boolean;
  checkpoint: number; ready: boolean; query_count: number; elapsed_seconds: number;
};
const finished = (s: Status) => ['finished', 'stopped', 'failed'].includes(s.phase);

async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
  const response = await fetch(path, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Native service returned ${response.status}.`);
  return result;
}

export function LiveEnumerationPanel({ onReady, onConnect, onPrepare, onRefresh, querying, canRefresh }: {
  onReady: (sessionId: string, meta: ArborEnumBuilderMeta) => void;
  onConnect: (sessionId: string) => void;
  onPrepare: () => void;
  onRefresh: () => void;
  querying: boolean;
  canRefresh: boolean;
}) {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [filename, setFilename] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lambda, setLambda] = useState(0.005), [depth, setDepth] = useState(5);
  const [multiplier, setMultiplier] = useState(0.01), [second, setSecond] = useState(0.01);
  const [runtime, setRuntime] = useState(600), [memory, setMemory] = useState(10000);
  const [proxy, setProxy] = useState('binarized');
  const sessionRef = useRef(''), readyRef = useRef(false);
  const draftRef = useRef(false), fileRead = useRef(0);
  const callbacks = useRef({ onReady, onConnect }); callbacks.current = { onReady, onConnect };

  useEffect(() => {
    if (!/^https?:$/.test(location.protocol)) return;
    let discovered = false;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        if (!discovered) {
          const health = await api<{ service: string }>('/api/health', undefined, controller.signal);
          if (health?.service !== 'arborenum-native-builder' || disposed) return;
          discovered = true;
          setAvailable(true);
        }
        const observedSession = sessionRef.current;
        const current = await api<Status>('/api/session', undefined, controller.signal);
        if (disposed || sessionRef.current !== observedSession) return;
        setStatus(current);
        if (current && !draftRef.current) {
          if (sessionRef.current !== current.session_id) {
            sessionRef.current = current.session_id; readyRef.current = false;
            callbacks.current.onConnect(current.session_id);
          }
          if (current.ready && !readyRef.current) {
            const meta = await api<ArborEnumBuilderMeta>(`/api/meta?session_id=${current.session_id}`, undefined, controller.signal);
            if (!disposed && !draftRef.current && meta && sessionRef.current === current.session_id) {
              readyRef.current = true; callbacks.current.onReady(current.session_id, meta);
              setError('');
            }
          }
          if (current.error) setError(current.error);
        }
      } catch (e) {
        if (!disposed && sessionRef.current) { setError(e instanceof Error ? e.message : 'Lost connection to the native service.'); }
      } finally { if (!disposed && discovered) timer = setTimeout(poll, 500); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, []);
  if (!available) return null;
  const running = status && !finished(status);
  const launch = async () => {
    if (!rows) return;
    setBusy(true); setError('');
    try {
      const dataset = toDataset(rows, target);
      draftRef.current = true;
      onPrepare();
      const current = await api<Status>('/api/session', { ...dataset, settings: { lambda_reg: lambda, depth_budget: depth, rashomon_mult: multiplier, second_rashomon_mult: second, runtime_limit_seconds: runtime, memory_limit_mb: memory, proxy_mode: proxy } });
      if (current) {
        sessionRef.current = current.session_id; readyRef.current = false;
        draftRef.current = false;
        setStatus(current); setOpen(false);
        callbacks.current.onConnect(current.session_id);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not launch enumeration.'); }
    finally { setBusy(false); }
  };
  return <div className="live-enumeration">
    <button className="ghost-button" onClick={() => setOpen(true)}><Play size={15} /> New enumeration</button>
    {status && <>
      <span className="live-progress" role="status">{status.stop_requested && !finished(status) ? 'Stopping…' : status.phase} · {Math.floor(status.elapsed_seconds)}s · {status.ready ? `${status.query_count} native queries` : 'waiting for first feasible tree'}</span>
      <button className="ghost-button" disabled={querying || !status.ready || !canRefresh} onClick={onRefresh}><RefreshCw size={15} className={querying ? 'live-spin' : ''} /> {querying ? 'Updating options…' : 'Update options'}</button>
      {running && <button className="ghost-button" disabled={status.stop_requested} onClick={async () => {
        try { const current = await api<Status>(`/api/stop?session_id=${status.session_id}`, {}); if (current) setStatus(current); }
        catch (e) { setError(String(e)); }
      }}><Square size={14} /> Stop</button>}
    </>}
    {error && <p className="upload-error live-error" role="alert">{error}</p>}
    {open && <div className="live-overlay" onClick={() => !busy && setOpen(false)}>
      <section className="live-dialog" role="dialog" aria-modal="true" aria-labelledby="live-title" onClick={e => e.stopPropagation()}>
        <button className="ghost-button live-close" aria-label="Close enumeration setup" onClick={() => setOpen(false)}><X size={18}/></button>
        <h2 id="live-title">Grow a Rashomon set</h2>
        <p>Choose a CSV and a classification target. TRUE/FALSE values become 1/0; other text categories become named binary indicators. Numeric columns keep their values. Node options update whenever you choose a split or select a node.</p>
        <label className="live-file">Dataset CSV<input type="file" accept=".csv,text/csv" disabled={busy} onChange={async e => {
          const file = e.target.files?.[0]; if (!file) return;
          const sequence = ++fileRead.current;
          draftRef.current = true;
          onPrepare(); setRows(null); setFilename(file.name); setTarget(''); setError('');
          try {
            const parsed = parseCsv(await file.text());
            if (sequence !== fileRead.current) return;
            setRows(parsed); setTarget(parsed[0].includes('label') ? 'label' : parsed[0][parsed[0].length - 1]);
          } catch (e) { if (sequence === fileRead.current) setError(String(e)); }
        }}/></label>
        {rows && <><p>{filename} · {(rows.length - 1).toLocaleString()} rows · {rows[0].length - 1} features</p><label>Target column<select value={target} onChange={e => setTarget(e.target.value)}>{rows[0].map(name => <option key={name}>{name}</option>)}</select></label></>}
        <div className="live-fields">
          <label>Leaf penalty λ<input aria-label="Leaf penalty" type="number" min="0" step="0.001" value={lambda} onChange={e => setLambda(e.target.valueAsNumber)}/></label>
          <label>Maximum depth<input type="number" min="0" max="20" value={depth} onChange={e => setDepth(e.target.valueAsNumber)}/></label>
          <label>Rashomon multiplier<input type="number" min="0" step="0.005" value={multiplier} onChange={e => { setMultiplier(e.target.valueAsNumber); setSecond(Math.max(second, e.target.valueAsNumber)); }}/></label>
          <label>Expand multiplier to<input type="number" min={multiplier} step="0.005" value={second} onChange={e => setSecond(e.target.valueAsNumber)}/></label>
          <label>Runtime limit (seconds)<input type="number" min="1" value={runtime} onChange={e => setRuntime(e.target.valueAsNumber)}/></label>
          <label>Memory limit (MB)<input type="number" min="1" value={memory} onChange={e => setMemory(e.target.valueAsNumber)}/></label>
          <label>Proxy mode<select value={proxy} onChange={e => setProxy(e.target.value)}><option value="hybrid">Hybrid</option><option value="continuous">Continuous</option><option value="binarized">Binarized</option></select></label>
        </div>
        {running && <p>Stop the current enumeration before starting another dataset.</p>}
        {error && <p role="alert" className="upload-error">{error}</p>}
        <button className="primary-button" disabled={!rows || busy || !!running || ![lambda, depth, multiplier, second, runtime, memory].every(Number.isFinite) || lambda < 0 || multiplier < 0 || second < multiplier || depth < 0 || depth > 20 || !Number.isInteger(depth) || runtime <= 0 || memory <= 0} onClick={() => void launch()}><Play size={16}/> {busy ? 'Starting…' : 'Start ArborEnum'}</button>
      </section>
    </div>}
  </div>;
}
