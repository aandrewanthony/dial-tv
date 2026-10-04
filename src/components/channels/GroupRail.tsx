import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, SlidersHorizontal } from 'lucide-react';

export interface RailItem {
  key: string;
  label: string;
  count: number;
  /** Lucide icon, or a short string (sport emoji, country code badge). */
  icon?: ReactNode;
  /** Section header shown above this item; `sectionKey` makes it a fold toggle. */
  section?: string;
  sectionKey?: string;
  sectionOpen?: boolean;
  /** A fold row (a country): toggles its children instead of selecting. */
  fold?: boolean;
  open?: boolean;
  /** Indented under a fold. */
  child?: boolean;
  /** Channels airing this right now (sports). */
  live?: number;
  /** Nothing to show (a sport with no channels): listed, but greyed out. */
  dim?: boolean;
  /** Only the section header (a folded section). */
  headerOnly?: boolean;
}

/**
 * Left group rail on Live TV: All / Favorites / Recent / My Channels, a Sports section (one row per
 * sport) and the visible groups folded by country.
 */
export function GroupRail({ items, value, onChange, onToggle, collapsed, onCollapse, onChoose }: {
  items: RailItem[];
  value: string;
  onChange: (key: string) => void;
  /** Open/close a fold row or a foldable section. */
  onToggle: (key: string) => void;
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  onChoose: () => void;
}) {
  if (collapsed) {
    const cur = items.find((i) => i.key === value);
    return (
      <aside className="groupRail collapsed" aria-label="Channel groups">
        <button className="icon" onClick={() => onCollapse(false)} title="Show groups" aria-label="Show groups"><ChevronsRight /></button>
        <span className="railVert">{cur?.label ?? 'All channels'}</span>
      </aside>
    );
  }
  return (
    <aside className="groupRail" aria-label="Channel groups">
      <div className="railHead">
        <span>BROWSE</span>
        <button className="icon" onClick={onChoose} title="Choose your channels" aria-label="Choose your channels"><SlidersHorizontal /></button>
        <button className="icon" onClick={() => onCollapse(true)} title="Hide groups" aria-label="Hide groups"><ChevronsLeft /></button>
      </div>
      <nav className="railList">
        {items.map((it) => (
          <div key={it.key} className="railItemWrap">
            {it.section && (it.sectionKey ? (
              <button className="railSection fold" aria-expanded={!!it.sectionOpen} onClick={() => onToggle(it.sectionKey!)}>
                {it.section}{it.sectionOpen ? <ChevronDown /> : <ChevronRight />}
              </button>
            ) : <div className="railSection">{it.section}</div>)}
            {it.headerOnly ? null : it.fold ? (
              <button className="railItem railFold" aria-expanded={!!it.open} onClick={() => onToggle(it.key)}>
                {it.open ? <ChevronDown /> : <ChevronRight />}
                {it.icon}
                <span className="railLabel">{it.label}</span>
                <span className="railCount">{it.count.toLocaleString()}</span>
              </button>
            ) : (
              <button
                className={`railItem ${value === it.key ? 'on' : ''} ${it.child ? 'child' : ''} ${it.dim ? 'dim' : ''}`}
                aria-pressed={value === it.key}
                disabled={it.dim}
                onClick={() => onChange(it.key)}
                data-group={it.key}
              >
                {typeof it.icon === 'string' ? <span className="railEmoji" aria-hidden>{it.icon}</span> : it.icon}
                <span className="railLabel">{it.label}</span>
                {!!it.live && <span className="railLive" title={`${it.live} on now`}>{it.live}</span>}
                <span className="railCount">{it.count.toLocaleString()}</span>
              </button>
            )}
          </div>
        ))}
      </nav>
    </aside>
  );
}
