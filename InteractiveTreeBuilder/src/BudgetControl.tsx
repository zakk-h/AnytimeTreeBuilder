import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { nativeApi } from './nativeGraph';
import type { Status } from './LiveEnumerationPanel';

export function BudgetControl({ status, onStatus }: { status: Status; onStatus: (status: Status) => void }) {
  const [draft, setDraft] = useState<number | null>(null), [text, setText] = useState<string | null>(null), [error, setError] = useState('');
  const latest = useRef(draft), current = useRef(status), alive = useRef(true), queue = useRef(Promise.resolve());
  latest.current = draft; current.current = status;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (draft === null) return;
    const timer = setTimeout(() => {
      // Serialize writes so a slower reply cannot restore an older budget.
      queue.current = queue.current.catch(() => {}).then(async () => {
        if (!alive.current || latest.current !== draft || current.current.requested_budget === draft) return;
        setError('');
        try {
          const next = await nativeApi<Status>('budget', status.session_id, { budget: draft });
          if (alive.current && latest.current === draft) onStatus(next);
        } catch (e) { if (alive.current && latest.current === draft) setError(e instanceof Error ? e.message : String(e)); }
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [draft, status.session_id, onStatus]);
  const value = draft ?? Math.max(0, status.requested_budget >= 0 ? status.requested_budget : status.active_budget);
  const max = Math.min(2147483647, Math.max(1, status.graph_budget * 2, value));
  const format = (n: number) => (n / status.sample_count).toFixed(6).replace(/\.?0+$/, '') || '0';
  const edit = (value: string) => {
    setText(value);
    if (!value.trim()) return;
    const units = Math.round(Number(value) * status.sample_count);
    if (!Number.isFinite(units) || Number(value) < 0 || units > 2147483647) { setError('Enter a valid nonnegative budget.'); return; }
    setError(''); setDraft(units);
  };
  return <details className="live-budget">
    <summary>Objective budget <b>{format(value)}</b><ChevronDown size={13}/></summary>
    <div className="live-budget-popover">
      <div className="live-budget-value"><label htmlFor={`budget-value-${status.session_id}`}>Objective budget</label>
        <input id={`budget-value-${status.session_id}`} aria-label="Objective budget value" type="number" min="0" max={2147483647 / status.sample_count} step={1 / status.sample_count} value={text ?? format(value)} onChange={e => edit(e.target.value)} onFocus={e => e.currentTarget.select()} onBlur={() => { setText(null); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
      </div>
      <input aria-label="Objective budget" type="range" min="0" max={max} step="1" value={value} onChange={e => { setText(null); setError(''); setDraft(Number(e.target.value)); }}/>
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
