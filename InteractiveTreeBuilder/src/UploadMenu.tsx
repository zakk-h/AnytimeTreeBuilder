import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileJson, Table2, Upload } from 'lucide-react';

export function UploadMenu({ liveAvailable, onDataset, onGraph }: {
  liveAvailable: boolean;
  onDataset: () => void;
  onGraph: (file: File) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    container.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const close = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div className="upload-menu" ref={container} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const items = [...container.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  }}>
    <button className="ghost-button upload-button" ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Upload size={15} /> Upload <ChevronDown size={13} />
    </button>
    {open && <div className="upload-popover" role="menu" aria-label="Upload options">
      <div className="upload-menu-label">START WITH YOUR DATA</div>
      <button role="menuitem" disabled={!liveAvailable} onClick={() => { setOpen(false); trigger.current?.focus(); onDataset(); }}>
        <Table2 size={20} /><span><b>Upload dataset</b><small>{liveAvailable ? 'Grow a new Rashomon set from CSV' : 'Available when the live service is connected'}</small></span>
      </button>
      <button role="menuitem" onClick={() => { setOpen(false); trigger.current?.focus(); input.current?.click(); }}>
        <FileJson size={20} /><span><b>Upload graph</b><small>Explore an existing Rashomon graph</small></span>
      </button>
    </div>}
    <input ref={input} type="file" aria-label="Upload graph JSON" accept=".json,application/json" hidden onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (file) onGraph(file);
    }} />
  </div>;
}
