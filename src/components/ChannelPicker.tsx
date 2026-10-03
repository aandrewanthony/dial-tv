import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface PickOption { id: string; label: string }

/**
 * Searchable picker that scales to provider playlists with thousands of channels
 * (a plain <select> per row would render every option for every row).
 */
export function ChannelPicker({ value, options, onChange, placeholder = '—', noneLabel = '— none —' }: {
  value?: string;
  options: PickOption[];
  onChange: (id: string | undefined) => void;
  placeholder?: string;
  noneLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (n ? options.filter((o) => o.label.toLowerCase().includes(n)) : options).slice(0, 60);
  }, [q, options]);

  return (
    <div className="picker" ref={ref}>
      <button type="button" className="field pickerBtn" onClick={() => { setOpen(!open); setQ(''); }}>
        <span>{current?.label ?? placeholder}</span><ChevronDown />
      </button>
      {open && (
        <div className="pickerPop">
          <input
            autoFocus
            className="field"
            placeholder="Search channels"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Keep Escape/Enter inside the picker (don't close a parent modal or submit its form).
              if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
              if (e.key === 'Enter') { e.preventDefault(); if (shown[0]) { onChange(shown[0].id); setOpen(false); } }
            }}
          />
          <div className="pickerList">
            <button type="button" onClick={() => { onChange(undefined); setOpen(false); }}>{noneLabel}</button>
            {shown.map((o) => (
              <button type="button" key={o.id} className={o.id === value ? 'on' : ''} onClick={() => { onChange(o.id); setOpen(false); }}>{o.label}</button>
            ))}
            {options.length > shown.length && !q && <small className="muted">Type to search {options.length} channels…</small>}
          </div>
        </div>
      )}
    </div>
  );
}
