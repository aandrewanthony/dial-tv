import { useDeferredValue, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Clapperboard, Info, ListPlus, Pencil, Play, Plus, Shuffle, Trash2, Tv, X } from 'lucide-react';
import { orderedChannels, useApp } from '../store/app';
import { createPersonal, deletePersonal, PERSONAL_PREFIX, updatePersonal, useTv } from '../store/tv';
import { listings, nextNumber, slotAt, type PersonalChannel, type PersonalItem } from '../lib/personalSchedule';
import { buildLibrary, episodeName, epLabel, titleOf, type Library } from '../components/tv/library';
import { asChannel, TvMark } from '../components/tv/personal';
import { leftLabel } from '../components/tv/InfoBanner';
import { Empty, Modal, fmtTime, useNow } from '../components/ui';
import { navigate } from '../app/router';
import type { Channel } from '../types';

const COLORS = ['#ff4d4d', '#f5b13d', '#3ccf7a', '#1fb6ff', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

const toItem = (c: Channel): PersonalItem => ({
  id: c.id,
  kind: c.kind === 'series' ? 'series' : 'movie',
  title: c.kind === 'series' ? c.series?.show ?? titleOf(c) : titleOf(c),
  subtitle: c.kind === 'series' ? `${epLabel(c)} · ${episodeName(c)}` : c.year ? String(c.year) : undefined,
});

/** My Channels: personal scheduled channels built from your movies and episodes, cable style. */
export default function ChannelsPage() {
  const personal = useTv((s) => s.personal);
  const durations = useTv((s) => s.durations);
  const [editing, setEditing] = useState<PersonalChannel | 'new' | null>(null);
  const [help, setHelp] = useState(false);
  const now = useNow(30_000);
  const sorted = useMemo(() => [...personal].sort((a, b) => a.number - b.number), [personal]);

  return (
    <div className="tvMyChannels">
      <div className="guideBar">
        <p className="muted small tvLead">Your own linear channels: pick movies and episodes, they play on a loop on a real schedule, and show up in Live TV and the Guide under “My Channels”.</p>
        <div className="chips">
          <button onClick={() => setHelp(true)}><Info /> How scheduling works</button>
          <button className="primary" onClick={() => setEditing('new')}><Plus /> New channel</button>
        </div>
      </div>
      {!sorted.length && (
        <Empty icon={<Tv />} title="No channels yet">Create a channel like “900 · Movie Night” or “901 · Sitcoms”, then add movies, whole shows, or genres from your library.</Empty>
      )}
      <div className="tvPGrid">
        {sorted.map((p) => {
          const ch = asChannel(p);
          const cur = slotAt(p, durations, now);
          const next = cur ? slotAt(p, durations, cur.end) : undefined;
          const pct = cur ? ((now - cur.start) / (cur.end - cur.start)) * 100 : 0;
          return (
            <div key={p.id} className="tvPCard" style={{ ['--pc' as string]: p.color }}>
              <div className="tvPHead">
                <TvMark channel={ch} size={44} />
                <div><small>CH {p.number}</small><b>{p.name}</b><span className="muted small">{p.items.length} item{p.items.length === 1 ? '' : 's'} · {p.order === 'shuffle' ? 'Shuffle' : 'In order'} · loops</span></div>
              </div>
              {cur ? (
                <div className="np tvPNow">
                  <small className="tvLbl">NOW</small>
                  <b>{cur.item.title}</b>{cur.item.subtitle && <span>{cur.item.subtitle}</span>}
                  <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                  <small>{fmtTime(cur.start)} – {fmtTime(cur.end)} · {leftLabel(cur, now)}</small>
                  {next && <p className="nextLine"><small>NEXT</small> {fmtTime(next.start)} · {next.item.title}{next.item.subtitle ? ` · ${next.item.subtitle}` : ''}</p>}
                </div>
              ) : <p className="muted">Nothing scheduled. Add movies or episodes.</p>}
              <div className="row">
                <button className="primary" disabled={!cur} onClick={() => { useApp.getState().tune(PERSONAL_PREFIX + p.id); navigate('watch'); }}><Play /> Watch</button>
                <button onClick={() => setEditing(p)}><Pencil /> Edit</button>
              </div>
            </div>
          );
        })}
      </div>
      {editing && <Editor def={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {help && (
        <Modal title="How My Channels scheduling works" onClose={() => setHelp(false)}>
          <div className="pd tvHelp">
            <p>Each channel loops its list forever (in order, or a shuffle that stays the same until you reshuffle). What is on right now is computed from the clock, like real TV: tune in and you join the current movie or episode mid-way.</p>
            <p>Playlists don’t say how long a movie or episode is, so Dial TV <b>estimates</b> 100 min for a movie and 45 min for an episode. Every time something plays (here or in Movies & Series), the real length is <b>remembered</b> and the schedule corrects itself: what is on now keeps playing, and everything after it moves to match.</p>
            <p>When an item finishes early or late, the next one starts right away and the guide follows.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Editor({ def, onClose }: { def: PersonalChannel | null; onClose: () => void }) {
  const channels = useApp((s) => s.channels);
  const channelOrder = useApp((s) => s.channelOrder);
  const hidden = useApp((s) => s.hidden);
  const personal = useTv((s) => s.personal);
  const durations = useTv((s) => s.durations);
  const lib = useMemo(() => buildLibrary(channels), [channels]);
  const taken = useMemo(() => [
    ...orderedChannels({ channels, channelOrder, hidden }, true).map((c) => c.number),
    ...personal.filter((p) => p.id !== def?.id).map((p) => p.number),
  ], [channels, channelOrder, hidden, personal, def]);
  const [name, setName] = useState(def?.name ?? '');
  const [number, setNumber] = useState(String(def?.number ?? nextNumber(taken)));
  const [color, setColor] = useState(def?.color ?? COLORS[personal.length % COLORS.length]);
  const [order, setOrder] = useState<PersonalChannel['order']>(def?.order ?? 'sequential');
  const [seed, setSeed] = useState(def?.seed ?? Math.floor(Math.random() * 2 ** 31));
  const [items, setItems] = useState<PersonalItem[]>(def?.items ?? []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const num = parseInt(number, 10);
  const numError = !Number.isFinite(num) || num < 1 ? 'Enter a channel number' : taken.includes(num) ? `CH ${num} is already used` : '';

  const add = (list: Channel[]) => setItems((cur) => {
    const have = new Set(cur.map((x) => x.id));
    return [...cur, ...list.filter((c) => !have.has(c.id)).map(toItem)];
  });
  const move = (i: number, d: number) => setItems((cur) => {
    const j = i + d;
    if (j < 0 || j >= cur.length) return cur;
    const next = cur.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const preview = useMemo(() => {
    const draft = { items, order, seed, anchor: def?.anchor ?? { at: Date.now(), index: 0 } };
    return listings(draft, durations, Date.now(), Date.now() + 6 * 3600_000, 8);
  }, [items, order, seed, def, durations]);

  const save = () => {
    if (numError) return;
    const patch = { name: name.trim() || 'My Channel', number: num, color, order, seed, items };
    if (def) updatePersonal(def.id, patch);
    else {
      createPersonal({ name: patch.name, number: num, color, items, order, seed });
    }
    onClose();
  };

  return (
    <Modal title={def ? `Edit ${def.name}` : 'New channel'} onClose={onClose} wide>
      <div className="tvEditor">
        <div className="tvEditorTop form">
          <label>Channel name<input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Movie Night" autoFocus /></label>
          <label className="tvNum">Number<input className="field" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} /></label>
          <div className="label">Color
            <div className="tvSwatches">{COLORS.map((c) => <button key={c} type="button" className={c === color ? 'on' : ''} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Color ${c}`} />)}</div>
          </div>
          <div className="label">Order
            <div className="chips">
              <button type="button" className={order === 'sequential' ? 'on' : ''} onClick={() => setOrder('sequential')}>In order</button>
              <button type="button" className={order === 'shuffle' ? 'on' : ''} onClick={() => setOrder('shuffle')}><Shuffle /> Shuffle</button>
              {order === 'shuffle' && <button type="button" onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}>Reshuffle</button>}
            </div>
          </div>
        </div>
        {numError && <p className="err small">{numError}</p>}

        <div className="tvEditorCols">
          <section>
            <h4>Lineup · {items.length} <span className="muted small">(loops forever)</span></h4>
            <div className="tvLineup">
              {items.map((it, i) => (
                <div key={it.id} className="tvLineupRow">
                  <span className="tvLineupKind">{it.kind === 'movie' ? <Clapperboard /> : <Tv />}</span>
                  <div><b>{it.title}</b>{it.subtitle && <small>{it.subtitle}</small>}</div>
                  <button className="icon" onClick={() => move(i, -1)} aria-label="Move up" disabled={i === 0}><ArrowUp /></button>
                  <button className="icon" onClick={() => move(i, 1)} aria-label="Move down" disabled={i === items.length - 1}><ArrowDown /></button>
                  <button className="icon" onClick={() => setItems((cur) => cur.filter((x) => x.id !== it.id))} aria-label={`Remove ${it.title}`}><X /></button>
                </div>
              ))}
              {!items.length && <p className="muted small">Nothing added yet. Search your library on the right.</p>}
              {items.length > 0 && <button className="ghost danger" onClick={() => setItems([])}><Trash2 /> Clear lineup</button>}
            </div>
            {preview.length > 0 && (
              <>
                <h4>Schedule preview</h4>
                <div className="tvPreviewList">
                  {preview.map((s) => <div key={s.start}><time>{fmtTime(s.start)}</time><span>{s.item.title}{s.item.subtitle ? ` · ${s.item.subtitle}` : ''}</span></div>)}
                </div>
              </>
            )}
          </section>
          <section>
            <h4>Add from your library</h4>
            <AddContent lib={lib} have={items} onAdd={add} />
          </section>
        </div>

        <div className="row tvEditorFoot">
          {def && (confirmDelete
            ? <><span className="muted small">Delete {def.name}?</span><button className="danger" onClick={() => { deletePersonal(def.id); onClose(); }}><Trash2 /> Delete</button><button className="ghost" onClick={() => setConfirmDelete(false)}>Keep</button></>
            : <button className="ghost danger" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete channel</button>)}
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={!!numError}>{def ? 'Save' : 'Create channel'}</button>
        </div>
      </div>
    </Modal>
  );
}

function AddContent({ lib, have, onAdd }: { lib: Library; have: PersonalItem[]; onAdd: (list: Channel[]) => void }) {
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim().toLowerCase());
  const haveIds = useMemo(() => new Set(have.map((x) => x.id)), [have]);
  const res = useMemo(() => {
    const match = (s: string) => !query || s.toLowerCase().includes(query);
    const shows = lib.shows.filter((s) => match(s.name)).slice(0, query ? 12 : 6);
    const groups = lib.movieGroups.filter(match).slice(0, query ? 8 : 6);
    const movies: Channel[] = [];
    if (query) for (const m of lib.movies) { if (lib.lower.get(m.id)!.includes(query)) movies.push(m); if (movies.length >= 30) break; }
    else movies.push(...lib.movies.slice(0, 12));
    const eps: Channel[] = [];
    if (query) for (const e of lib.episodes) { if (titleOf(e).toLowerCase().includes(query)) eps.push(e); if (eps.length >= 20) break; }
    return { shows, groups, movies, eps };
  }, [lib, query]);
  if (!lib.movies.length && !lib.episodes.length) return <p className="muted small">No movies or episodes in your playlists yet.</p>;
  return (
    <div className="tvAdd">
      <input className="field" placeholder="Search your library" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search your library" />
      <div className="tvAddList">
        {res.shows.map((s) => (
          <div key={s.key} className="tvAddRow">
            <Tv /><div><b>{s.name}</b><small>Whole show · {s.episodes.length} episodes</small></div>
            <button onClick={() => onAdd(s.episodes)} aria-label={`Add show ${s.name}`}><ListPlus /> Add show</button>
          </div>
        ))}
        {res.groups.map((g) => {
          const list = lib.movies.filter((m) => m.group === g);
          return (
            <div key={`g:${g}`} className="tvAddRow">
              <Clapperboard /><div><b>{g}</b><small>Movie group · {list.length} movies</small></div>
              <button onClick={() => onAdd(list)} aria-label={`Add group ${g}`}><ListPlus /> Add all</button>
            </div>
          );
        })}
        {[...res.movies, ...res.eps].map((c) => (
          <div key={c.id} className="tvAddRow">
            {c.kind === 'series' ? <Tv /> : <Clapperboard />}
            <div><b>{c.kind === 'series' ? `${c.series?.show} · ${epLabel(c)}` : titleOf(c)}</b><small>{c.kind === 'series' ? episodeName(c) : [c.year, c.group].filter(Boolean).join(' · ')}</small></div>
            <button disabled={haveIds.has(c.id)} onClick={() => onAdd([c])} aria-label={`Add ${titleOf(c)}`}>{haveIds.has(c.id) ? 'Added' : <><Plus /> Add</>}</button>
          </div>
        ))}
        {!res.shows.length && !res.groups.length && !res.movies.length && !res.eps.length && <p className="muted small">No matches.</p>}
      </div>
    </div>
  );
}

