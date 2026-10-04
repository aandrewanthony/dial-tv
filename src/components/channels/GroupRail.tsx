import type { ReactNode } from 'react';
import { ChevronsLeft, ChevronsRight, SlidersHorizontal } from 'lucide-react';

export interface RailItem {
  key: string;
  label: string;
  count: number;
  icon?: ReactNode;
  /** Section header shown above this item. */
  section?: string;
}

/** Left group rail on Live TV: Favorites, Recently watched, My Channels, then the visible groups in the user's order. */
export function GroupRail({ items, value, onChange, collapsed, onCollapse, onChoose }: {
  items: RailItem[];
  value: string;
  onChange: (key: string) => void;
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
        <span>GROUPS</span>
        <button className="icon" onClick={onChoose} title="Choose your channels" aria-label="Choose your channels"><SlidersHorizontal /></button>
        <button className="icon" onClick={() => onCollapse(true)} title="Hide groups" aria-label="Hide groups"><ChevronsLeft /></button>
      </div>
      <nav className="railList">
        {items.map((it) => (
          <div key={it.key} className="railItemWrap">
            {it.section && <div className="railSection">{it.section}</div>}
            <button className={`railItem ${value === it.key ? 'on' : ''}`} aria-pressed={value === it.key} onClick={() => onChange(it.key)} data-group={it.key}>
              {it.icon}
              <span className="railLabel">{it.label}</span>
              <span className="railCount">{it.count}</span>
            </button>
          </div>
        ))}
      </nav>
    </aside>
  );
}
