import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, EyeOff, Heart, Layers, MonitorPlay } from 'lucide-react';
import { useApp } from '../../store/app';
import { setVariantChoice, toggleGroupHidden } from '../../store/channelPrefs';
import { activeVariant, type OrgChannel } from '../../lib/channelOrg';
import type { Channel } from '../../types';
import { isFavorite, isOrg, toggleFavorite } from './useOrganized';

/** Small floating menu at a screen point; closes on outside click, Escape or scroll. */
export function Popover({ x, y, onClose, children, label }: { x: number; y: number; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
    }
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); };
  }, [x, y, onClose]);
  return createPortal(
    <div ref={ref} className="chMenu" role="menu" aria-label={label} style={pos}>{children}</div>,
    document.body,
  );
}

/** Quality variants of a merged channel as menu items (radio). */
export function VariantItems({ c, onPicked }: { c: OrgChannel; onPicked?: () => void }) {
  const active = activeVariant(c);
  return (
    <>
      {c.variants.map((v, i) => (
        <button
          key={v.id}
          role="menuitemradio"
          aria-checked={i === active}
          className={i === active ? 'on' : ''}
          onClick={() => { setVariantChoice(c.id, i === 0 ? undefined : v.id); onPicked?.(); }}
          title={v.rawName}
        >
          {i === active ? <Check /> : <span className="chMenuPad" />} {v.label}
          {i === 0 && <small>best for your settings</small>}
        </button>
      ))}
    </>
  );
}

/** Right-click / "⋯" menu of a channel row: favorite, quality, hide channel or its group. */
export function ChannelMenu({ c, x, y, onClose }: { c: Channel; x: number; y: number; onClose: () => void }) {
  const fav = useApp((s) => isFavorite(s.favorites, c));
  const org = isOrg(c) ? c : undefined;
  return (
    <Popover x={x} y={y} onClose={onClose} label={`${c.name} menu`}>
      <div className="chMenuHead">{org?.displayName ?? c.name}</div>
      <button role="menuitem" onClick={() => { toggleFavorite(c); onClose(); }}><Heart fill={fav ? 'currentColor' : 'none'} /> {fav ? 'Remove from favorites' : 'Add to favorites'}</button>
      {org && org.variants.length > 1 && (
        <>
          <div className="chMenuSep">Quality</div>
          <VariantItems c={org} onPicked={onClose} />
        </>
      )}
      {org && (
        <>
          <div className="chMenuSep" />
          <button role="menuitem" onClick={() => { useApp.getState().update((st) => ({ hidden: [...st.hidden, c.id] })); onClose(); }}><EyeOff /> Hide channel</button>
          <button role="menuitem" onClick={() => { toggleGroupHidden(org.groupKey, true); onClose(); }}><Layers /> Hide group “{org.group}”</button>
        </>
      )}
    </Popover>
  );
}

/** "Quality: FHD ▾" button for the tuned channel (only when it has several variants). */
export function QualityButton({ c }: { c: OrgChannel }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  if (c.variants.length < 2) return null;
  const v = c.variants[activeVariant(c)];
  return (
    <>
      <button
        className="qualityBtn"
        aria-haspopup="menu"
        title={`${c.variants.length} sources for this channel`}
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setAt({ x: r.left, y: r.bottom + 4 }); }}
      >
        <MonitorPlay /> {v.label} <small>· {c.variants.length}</small> <ChevronDown />
      </button>
      {at && (
        <Popover x={at.x} y={at.y} onClose={() => setAt(null)} label="Quality">
          <div className="chMenuHead">Quality</div>
          <VariantItems c={c} onPicked={() => setAt(null)} />
        </Popover>
      )}
    </>
  );
}
