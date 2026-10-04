import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { Modal } from '../ui';
import { orderedChannels, useApp } from '../../store/app';
import { setChannelPrefs, useChannelPrefs } from '../../store/channelPrefs';
import { CATEGORIES, countryName, localeCountry, type Category, type Organized } from '../../lib/channelOrg';
import { useOrganized } from './useOrganized';

/** Playlists with more entries than this get the "Choose your channels" picker after they're added. */
export const PICKER_THRESHOLD = 300;
const DEFAULT_CATS: Category[] = ['Sports', 'News', 'Locals', 'Entertainment'];

/** Mark every current playlist as "picked", so the picker doesn't open again by itself. */
function markPicked() {
  const ids = useApp.getState().playlists.map((p) => p.id);
  setChannelPrefs((s) => ({ pickedSources: [...new Set([...s.pickedSources, ...ids])] }));
}

/** Initial selection: what's visible now, or (first run) the locale country + Sports, News, Locals, Entertainment. */
function initialSelection(org: Organized, hiddenGroups: string[]) {
  const hidden = new Set(hiddenGroups);
  if (hidden.size) {
    const vis = org.groups.filter((g) => !hidden.has(g.key));
    return { countries: new Set(vis.map((g) => g.country ?? '')), cats: new Set(vis.map((g) => g.category)) };
  }
  const home = localeCountry();
  const has = org.countries.some((c) => c.code === home);
  const country = has ? home : org.countries[0]?.code ?? '';
  const cats = new Set<Category>(DEFAULT_CATS.filter((c) => org.groups.some((g) => g.category === c && (g.country ?? '') === country)));
  if (!cats.size) for (const g of org.groups) if ((g.country ?? '') === country) cats.add(g.category);
  return { countries: new Set([country]), cats };
}

/** "Choose your channels": pick countries and categories; everything else is hidden (changeable later in Settings → Channels). */
export function GroupPicker({ onClose }: { onClose: () => void }) {
  const { org } = useOrganized();
  const hiddenGroups = useChannelPrefs((s) => s.hiddenGroups);
  const [sel, setSel] = useState(() => initialSelection(org, hiddenGroups));
  const home = useMemo(localeCountry, []);

  const countries = useMemo(
    () => [...org.countries].sort((a, b) => (a.code === home ? -1 : b.code === home ? 1 : b.count - a.count)),
    [org, home],
  );
  const catCounts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const g of org.groups) if (sel.countries.has(g.country ?? '')) m.set(g.category, (m.get(g.category) ?? 0) + g.count);
    return m;
  }, [org, sel.countries]);
  const picked = useMemo(
    () => org.groups.filter((g) => sel.countries.has(g.country ?? '') && sel.cats.has(g.category)).reduce((n, g) => n + g.count, 0),
    [org, sel],
  );

  const flip = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v); else n.add(v);
    return n;
  };
  const close = () => { markPicked(); onClose(); };
  const apply = () => {
    const shown = (g: Organized['groups'][number]) => sel.countries.has(g.country ?? '') && sel.cats.has(g.category);
    const cOrder = countries.map((c) => c.code ?? '');
    // Visible groups first: picked countries (home first), categories in canonical order; then the rest.
    const order = [...org.groups].sort((a, b) =>
      Number(shown(b)) - Number(shown(a))
      || cOrder.indexOf(a.country ?? '') - cOrder.indexOf(b.country ?? '')
      || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
    setChannelPrefs({ hiddenGroups: org.groups.filter((g) => !shown(g)).map((g) => g.key), groupOrder: order.map((g) => g.key) });
    markPicked();
    // The tuned channel was just hidden (e.g. the playlist's first entry): tune the first visible one.
    const app = useApp.getState();
    const visible = orderedChannels(app);
    if (app.currentId && !app.currentId.startsWith('my:') && visible.length && !visible.some((c) => c.id === app.currentId)) app.tune(visible[0].id);
    onClose();
  };
  const showAll = () => { setChannelPrefs({ hiddenGroups: [] }); markPicked(); onClose(); };

  return (
    <Modal title="Choose your channels" onClose={close} wide>
      <div className="groupPicker">
        <p className="muted">Your playlist has <b>{org.rawCount.toLocaleString()}</b> entries — <b>{org.all.length.toLocaleString()}</b> channels once duplicates are merged. Pick what you watch; everything else is hidden. Change it any time in Settings → Channels.</p>
        <h4>Countries</h4>
        <div className="pickGrid" role="group" aria-label="Countries">
          {countries.map((c) => {
            const code = c.code ?? '';
            const on = sel.countries.has(code);
            return (
              <button key={code} className={`pickChip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setSel((s) => ({ ...s, countries: flip(s.countries, code) }))}>
                {on ? <Check /> : <span className="pickBox" />}
                <span className="pickName">{c.code ? <><b className="ccBadge">{c.code}</b> {countryName(c.code)}</> : 'No country'}</span>
                <small>{c.count}</small>
              </button>
            );
          })}
        </div>
        <h4>Categories</h4>
        <div className="pickGrid" role="group" aria-label="Categories">
          {CATEGORIES.filter((cat) => org.groups.some((g) => g.category === cat)).map((cat) => {
            const on = sel.cats.has(cat);
            return (
              <button key={cat} className={`pickChip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setSel((s) => ({ ...s, cats: flip(s.cats, cat) }))}>
                {on ? <Check /> : <span className="pickBox" />}
                <span className="pickName">{cat}</span>
                <small>{catCounts.get(cat) ?? 0}</small>
              </button>
            );
          })}
        </div>
        <div className="pickFoot">
          <span className="pickTotal"><b>{picked.toLocaleString()}</b> channels selected</span>
          <button className="ghost" onClick={showAll}>Show everything</button>
          <button className="primary" onClick={apply} disabled={!picked}>Show {picked.toLocaleString()} channels</button>
        </div>
      </div>
    </Modal>
  );
}

/** Opens the picker by itself once after a big playlist (> 300 entries) is added. */
export function GroupPickerAuto() {
  const need = useApp((s) => !s.loadingSources && s.playlists.some((p) => p.enabled && (p.channelCount ?? 0) > PICKER_THRESHOLD));
  const playlists = useApp((s) => s.playlists);
  const hydrated = useChannelPrefs((s) => s.hydrated);
  const picked = useChannelPrefs((s) => s.pickedSources);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!need || !hydrated || open) return;
    if (playlists.some((p) => p.enabled && (p.channelCount ?? 0) > PICKER_THRESHOLD && !picked.includes(p.id))) setOpen(true);
  }, [need, hydrated, picked, playlists, open]);
  return open ? <GroupPicker onClose={() => setOpen(false)} /> : null;
}
