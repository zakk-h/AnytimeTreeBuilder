import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { nativeApi } from './nativeGraph';
import type { Status } from './LiveEnumerationPanel';

export function BudgetControl({ status, onStatus }: { status: Status; onStatus: (status: Status) => void }) {
  const [draft, setDraft] = useState<number | null>(null), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const latest = useRef(draft), current = useRef(status), alive = useRef(true), queue = useRef(Promise.resolve());
  latest.current = draft; current.current = status;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (draft === null) return;
    const timer = setTimeout(() => {
      // Serialize writes so a slower reply cannot restore an older budget.
      queue.current = queue.current.catch(() => {}).then(async () => {
        if (!alive.current || latest.current !== draft || current.current.requested_budget === draft) return;
        setSaving(true); setError('');
        try {
          const next = await nativeApi<Status>('budget', status.session_id, { budget: draft });
          if (alive.current && latest.current === draft) onStatus(next);
        } catch (e) { if (alive.current && latest.current === draft) setError(e instanceof Error ? e.message : String(e)); }
        finally { if (alive.current) setSaving(false); }
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [draft, status.session_id, onStatus]);
  const active = Math.max(0, status.active_budget), value = draft ?? (status.requested_budget >= 0 ? status.requested_budget : active);
  const max = Math.min(2147483647, Math.max(1, status.graph_budget * 2, active, value));
  const format = (n: number) => (n / status.sample_count).toFixed(4);
  const stopped = ['finished', 'stopped', 'failed'].includes(status.phase);
  const pending = status.requested_budget >= 0 && status.requested_budget !== active;
  return <details className="live-budget">
    <summary>Budget <b>{format(active)}</b><ChevronDown size={13}/></summary>
    <div className="live-budget-popover">
      <label htmlFor={`budget-${status.session_id}`}>Objective budget <output>{format(value)}</output></label>
      <input id={`budget-${status.session_id}`} aria-label="Objective budget" type="range" min="0" max={max} step="1" value={value} onChange={e => setDraft(Number(e.target.value))}/>
      <div className="live-budget-range"><span>0</span><span>{format(max)}</span></div>
      <p>Includes classification loss and leaf penalties.</p>
      <p role="status">{saving ? 'Saving…' : pending ? 'Applies at the next refinement round.' : stopped ? 'Filters the retained graph.' : 'Changes apply at the next refinement round.'}</p>
      {value < status.root_minimum && <p>No represented tree fits this budget yet.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
