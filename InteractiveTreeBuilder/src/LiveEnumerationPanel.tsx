import { readNativeResponse } from './nativeResponse';
import { useEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Square, X, Table2 } from 'lucide-react';
import type { ArborEnumBuilderMeta } from './arborenumPayload';
import './liveEnumeration.css';
import { parseCsv, toDataset } from './liveDataset';
import { DEFAULT_TRAINING_SETTINGS, nativeTrainingSettings, trainingSettingsError } from './trainingSettings';
import { TrainingFields } from './TrainingFields';

type Status = {
  session_id: string; phase: string; error: string; stop_requested: boolean;
  checkpoint: number; ready: boolean; query_count: number; elapsed_seconds: number;
  actual_root_budget: number; requested_root_budget: number;
  focus_running: boolean; focus_requested: boolean; focus_uid: number; focus_error: string;
};
const finished = (s: Status) => ['finished', 'stopped', 'failed'].includes(s.phase);

async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
  const response = await fetch(path, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (response.status === 204) return null;
  const result = await readNativeResponse(response, path.split('?')[0]);
  if (!response.ok) throw new Error(result.error ?? `Native service returned ${response.status}.`);
  return result;
}

export function LiveEnumerationPanel({ onReady, onConnect, onPrepare, onRefresh, onBudgetFilter, onFocusStatus, currentRootBudget, currentRootMinimum, trainingSampleCount, querying, canRefresh, open, onClose, onAvailable }: {
  onReady: (sessionId: string, meta: ArborEnumBuilderMeta) => void;
  onConnect: (sessionId: string) => void;
  onPrepare: () => void;
  onRefresh: () => void;
  onBudgetFilter: (budget: number | null) => void;
  onFocusStatus: (uid: number | null) => void;
  currentRootBudget: number;
  currentRootMinimum: number;
  trainingSampleCount: number;
  querying: boolean;
  canRefresh: boolean;
  open: boolean;
  onClose: () => void;
  onAvailable: (available: boolean) => void;
}) {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [budgetValue, setBudgetValue] = useState<number | null>(null);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [filename, setFilename] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState({ ...DEFAULT_TRAINING_SETTINGS });
  const settingsError = trainingSettingsError(settings);
  const sessionRef = useRef(''), readyRef = useRef(false);
  const draftRef = useRef(false), fileRead = useRef(0);
  const dialog = useRef<HTMLElement>(null);
  const callbacks = useRef({ onReady, onConnect, onAvailable, onFocusStatus }); callbacks.current = { onReady, onConnect, onAvailable, onFocusStatus };

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);

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
          setAvailable(true); callbacks.current.onAvailable(true);
        }
        const observedSession = sessionRef.current;
        const current = await api<Status>('/api/session', undefined, controller.signal);
        if (disposed || sessionRef.current !== observedSession) return;
        setStatus(current);
        callbacks.current.onFocusStatus(current && (current.focus_running || current.focus_requested) ? current.focus_uid : null);
        if (current && !draftRef.current) {
          if (sessionRef.current !== current.session_id) {
            sessionRef.current = current.session_id; readyRef.current = false;
            setBudgetValue(null);
            onBudgetFilter(null);
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
  useEffect(() => {
    if (budgetValue === null || !status?.ready) return;
    const id = status.session_id;
    const timer = setTimeout(() => {
      void api<Status>(`/api/budget?session_id=${id}`, { budget: budgetValue })
        .catch(e => setError(e instanceof Error ? e.message : String(e)));
    }, 250);
    return () => clearTimeout(timer);
  }, [budgetValue, status?.session_id, status?.ready]);

  if (!available) return null;
  const running = status && !finished(status);
  const nativeBudget = Number.isFinite(currentRootBudget) ? Math.max(0, Math.round(currentRootBudget)) : 0;
  const minimumBudget = Number.isFinite(currentRootMinimum) ? Math.max(0, Math.round(currentRootMinimum)) : 0;
  const chosenBudget = budgetValue ?? nativeBudget;
  const sliderMax = Math.max(chosenBudget + 1, nativeBudget + Math.max(10, Math.ceil(trainingSampleCount * 0.1)));
  const updateBudget = (value: number) => {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 1000000000) return;
    setBudgetValue(value);
    onBudgetFilter(value);
  };
  const launch = async () => {
    if (!rows) return;
    setBusy(true); setError('');
    try {
      const dataset = toDataset(rows, target);
      draftRef.current = true;
      onPrepare();
      const current = await api<Status>('/api/session', { ...dataset, settings: nativeTrainingSettings(settings) });
      if (current) {
        sessionRef.current = current.session_id; readyRef.current = false;
        draftRef.current = false;
        setStatus(current); onClose();
        callbacks.current.onConnect(current.session_id);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not launch enumeration.'); }
    finally { setBusy(false); }
  };
  return <div className="live-enumeration">
    {status && <>
      <span className="live-progress" role="status">{status.stop_requested && !finished(status) ? 'Stopping…' : status.phase} · {Math.floor(status.elapsed_seconds)}s · {status.ready ? `${status.query_count} native queries` : 'waiting for first feasible tree'}</span>
      {status.ready && <div className="live-budget-control" aria-label="Interactive Rashomon budget">
        <label htmlFor="live-root-budget">Rashomon budget</label>
        <input id="live-root-budget" aria-label="Rashomon budget slider" type="range"
          min={Math.min(minimumBudget, chosenBudget)} max={sliderMax} step={1}
          value={chosenBudget} onChange={event => updateBudget(Number(event.target.value))} />
        <input aria-label="Rashomon objective budget" type="number" min={0} max={1000000000}
          step={1} value={chosenBudget} onChange={event => updateBudget(Number(event.target.value))} />
        <span>{(chosenBudget / Math.max(1, trainingSampleCount)).toFixed(4)} per sample</span>
        {chosenBudget > nativeBudget && <span>Expanding when safe…</span>}
        {chosenBudget < nativeBudget && <span>Filtering existing solutions</span>}
      </div>}
      <button className="ghost-button" disabled={querying || !status.ready || !canRefresh} onClick={onRefresh}><RefreshCw size={15} className={querying ? 'live-spin' : ''} /> {querying ? 'Updating options…' : 'Update options'}</button>
      {running && <button className="ghost-button" disabled={status.stop_requested} onClick={async () => {
        try { const current = await api<Status>(`/api/stop?session_id=${status.session_id}`, {}); if (current) setStatus(current); }
        catch (e) { setError(String(e)); }
      }}><Square size={14} /> Stop</button>}
    </>}
    {status?.focus_error && <p className="upload-error live-error" role="alert">{status.focus_error}</p>}
    {error && <p className="upload-error live-error" role="alert">{error}</p>}
    {open && <div className="live-overlay" onClick={() => !busy && onClose()}>
      <section ref={dialog} className="live-dialog" role="dialog" aria-modal="true" aria-labelledby="live-title" onClick={e => e.stopPropagation()} onKeyDown={event => {
        if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const items = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), summary')].filter(item => item.getClientRects().length > 0);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <button className="ghost-button live-close" aria-label="Close enumeration setup" disabled={busy} onClick={() => onClose()}><X size={18}/></button>
        <div className="dialog-eyebrow"><Table2 size={16} /> DATASET IMPORT</div>
        <h2 id="live-title">Build from your data.</h2>
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
        {rows && <><p>{filename} · {(rows.length - 1).toLocaleString()} rows · {rows[0].length - 1} features</p><label>Target column<select aria-label="Target column" value={target} onChange={e => setTarget(e.target.value)}>{rows[0].map(name => <option key={name}>{name}</option>)}</select></label></>}
        <TrainingFields value={settings} onChange={setSettings}/>
        {settingsError && <p role="alert" className="upload-error">{settingsError}</p>}
        {running && <p>Stop the current enumeration before starting another dataset.</p>}
        {error && <p role="alert" className="upload-error">{error}</p>}
        <button className="primary-button" disabled={!rows || busy || !!running || !!settingsError} onClick={() => void launch()}><Play size={16}/> {busy ? 'Starting…' : 'Start ArborEnum'}</button>
      </section>
    </div>}
  </div>;
}
