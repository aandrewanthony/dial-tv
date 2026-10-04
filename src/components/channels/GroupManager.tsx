import { memo, useMemo, useState } from 'react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ArrowDownAZ, GripVertical, RotateCcw } from 'lucide-react';
import { setChannelPrefs, toggleGroupHidden } from '../../store/channelPrefs';
import { CATEGORIES, countryName } from '../../lib/channelOrg';
import { useOrganized } from './useOrganized';

type GroupView = ReturnType<typeof useOrganized>['groups'][number];

const GroupRow = memo(function GroupRow({ g }: { g: GroupView }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: g.key });
  const [name, setName] = useState(g.label);
  const commit = () => {
    const v = name.trim();
    setChannelPrefs((s) => {
      const n = { ...s.groupNames };
      if (!v || v === g.defaultLabel) delete n[g.key]; else n[g.key] = v;
      return { groupNames: n };
    });
    if (!v) setName(g.defaultLabel);
  };
  return (
    <div ref={setNodeRef} className={`grpRow ${g.hidden ? 'hiddenCh' : ''}`} data-group={g.key} style={{ transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined, transition }}>
      <span className="grip" {...attributes} {...listeners} aria-label={`Drag ${g.label}`}><GripVertical /></span>
      <input type="checkbox" checked={!g.hidden} onChange={() => toggleGroupHidden(g.key)} aria-label={`Show ${g.label}`} />
      {g.country ? <span className="ccBadge">{g.country}</span> : <span className="ccBadge dim">—</span>}
      <input
        className="grpName"
        value={name}
        aria-label={`Name of group ${g.defaultLabel}`}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <small>{g.count}</small>
    </div>
  );
});

/** Settings → Channels → Groups: show/hide (also per country), drag to reorder, rename. */
export function GroupManager({ onChoose }: { onChoose: () => void }) {
  const { groups } = useOrganized();
  const [country, setCountry] = useState<string>('*');
  const countries = useMemo(() => {
    const m = new Map<string, { total: number; shown: number; channels: number }>();
    for (const g of groups) {
      const k = g.country ?? '';
      const v = m.get(k) ?? { total: 0, shown: 0, channels: 0 };
      v.total++;
      v.channels += g.count;
      if (!g.hidden) v.shown++;
      m.set(k, v);
    }
    return [...m.entries()].sort((a, b) => b[1].channels - a[1].channels);
  }, [groups]);
  const shown = useMemo(() => (country === '*' ? groups : groups.filter((g) => (g.country ?? '') === country)), [groups, country]);
  const ids = useMemo(() => shown.map((g) => g.key), [shown]);
  const visibleCount = groups.filter((g) => !g.hidden).length;

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const all = groups.map((g) => g.key);
    setChannelPrefs({ groupOrder: arrayMove(all, all.indexOf(String(e.active.id)), all.indexOf(String(e.over.id))) });
  };
  const setCountryHidden = (code: string, hide: boolean) =>
    setChannelPrefs((s) => {
      const keys = groups.filter((g) => (g.country ?? '') === code).map((g) => g.key);
      const set = new Set(s.hiddenGroups);
      for (const k of keys) if (hide) set.add(k); else set.delete(k);
      return { hiddenGroups: [...set] };
    });
  const sortByCountry = () => {
    const cOrder = countries.map(([c]) => c);
    const sorted = [...groups].sort((a, b) =>
      Number(a.hidden) - Number(b.hidden)
      || cOrder.indexOf(a.country ?? '') - cOrder.indexOf(b.country ?? '')
      || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
    setChannelPrefs({ groupOrder: sorted.map((g) => g.key) });
  };

  return (
    <section className="panel groupManager">
      <div className="panelHead">
        <h2>Groups · {visibleCount} of {groups.length} shown</h2>
        <div className="row">
          <button className="primary" onClick={onChoose}>Choose channels…</button>
          <button className="ghost" onClick={sortByCountry} title="Shown groups first, by country then category"><ArrowDownAZ /> Sort</button>
          <button className="ghost" onClick={() => setChannelPrefs({ groupOrder: [], groupNames: {} })} title="Default order and names"><RotateCcw /> Reset</button>
        </div>
      </div>
      <p className="muted small">Your playlist’s groups, cleaned up into country + category. Untick to hide, drag to reorder, click a name to rename.</p>
      <div className="countryRows" role="group" aria-label="Countries">
        {countries.map(([code, v]) => (
          <div className="countryRow" key={code || 'none'} data-country={code}>
            <input
              type="checkbox"
              checked={v.shown === v.total}
              ref={(el) => { if (el) el.indeterminate = v.shown > 0 && v.shown < v.total; }}
              onChange={() => setCountryHidden(code, v.shown === v.total)}
              aria-label={`Show all from ${countryName(code || undefined)}`}
            />
            <button className={`linkish ${country === code ? 'on' : ''}`} onClick={() => setCountry(country === code ? '*' : code)}>
              {code ? <b className="ccBadge">{code}</b> : null} {countryName(code || undefined)}
            </button>
            <small>{v.shown}/{v.total} groups · {v.channels} ch</small>
            {v.shown > 0 && <button className="ghost tiny" onClick={() => setCountryHidden(code, true)}>Hide all</button>}
          </div>
        ))}
      </div>
      {country !== '*' && <p className="muted small">Showing {countryName(country || undefined)} only · <button className="link" onClick={() => setCountry('*')}>ALL COUNTRIES</button></p>}
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="chList grpList">{shown.map((g) => <GroupRow key={`${g.key}:${g.label}`} g={g} />)}</div>
        </SortableContext>
      </DndContext>
    </section>
  );
}
