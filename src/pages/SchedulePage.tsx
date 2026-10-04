import { useHealthDeps } from '../components/channels/useOrganized';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bell, Plus, Repeat, Sparkles, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { orderedChannels, useApp } from '../store/app';
import type { ScheduleEntry, ScheduleRule } from '../types';
import { entryFromGame, entryFromProgram, findConflicts, HOUR, layoutLanes, MIN, snap, startOfDay } from '../lib/scheduler';
import { Modal, Toggle, fmtDay, fmtTime, useNow } from '../components/ui';
import { ChannelPicker } from '../components/ChannelPicker';
import { leagueLabel } from '../lib/sports';
import { addRuleEntries } from '../hooks/useEngine';
import { SmartPlanner } from '../components/sports/SmartPlan';
import { useRoute } from '../app/router';

const PPM = 1.2; // px per minute → 72px per hour
const DAY_MIN = 24 * 60;

type Drag = { id: string; mode: 'move' | 'resize'; y0: number; start: number; end: number; moved: boolean };

export default function SchedulePage() {
  const schedule = useApp((s) => s.schedule);
  const games = useApp((s) => s.games);
  const programs = useApp((s) => s.programs);
  const channels = useApp((s) => s.channels);
  const rulesCount = useApp((s) => s.rules.length);
  const update = useApp((s) => s.update);
  // Minute-resolution clock: keeps memoized filters stable between renders (e.g. during drags).
  const now = useNow(60_000);
  const [day, setDay] = useState(() => startOfDay(Date.now()));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [editing, setEditing] = useState<ScheduleEntry | null>(null);
  const { param } = useRoute();
  const [tab, setTab] = useState<'smart' | 'day' | 'agenda' | 'rules'>(param === 'smart' ? 'smart' : 'day');
  useEffect(() => { if (param === 'smart') setTab('smart'); }, [param]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const colRef = useRef<HTMLDivElement>(null);

  const dayEnd = startOfDay(day + 26 * HOUR);
  const entries = useMemo(() => {
    const list = schedule.map((e) => (drag && e.id === drag.id ? { ...e, start: drag.start, end: drag.end } : e));
    return list.filter((e) => e.end > day && e.start < dayEnd);
  }, [schedule, drag, day, dayEnd]);
  const conflicts = useMemo(() => findConflicts(schedule.filter((e) => e.end > Date.now())), [schedule]);
  const lanes = useMemo(() => layoutLanes(entries), [entries]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = Date.now() >= day && Date.now() < dayEnd ? (Date.now() - day) / MIN - 90 : 17 * 60;
    el.scrollTop = Math.max(0, target * PPM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  const commit = (d: Drag) => update((st) => ({ schedule: st.schedule.map((e) => (e.id === d.id ? { ...e, start: d.start, end: d.end } : e)) }));

  useEffect(() => {
    if (!drag) return;
    const move = (ev: PointerEvent) => {
      setDrag((d) => {
        if (!d) return d;
        const dy = ev.clientY - d.y0;
        const orig = useApp.getState().schedule.find((e) => e.id === d.id)!;
        const deltaMs = snap((dy / PPM) * MIN);
        if (d.mode === 'move') return { ...d, start: orig.start + deltaMs, end: orig.end + deltaMs, moved: d.moved || Math.abs(dy) > 3 };
        return { ...d, end: Math.max(orig.start + 15 * MIN, orig.end + deltaMs), moved: d.moved || Math.abs(dy) > 3 };
      });
    };
    const up = () => {
      const d = dragRef.current;
      if (d) {
        if (d.moved) commit(d);
        else setEditing(useApp.getState().schedule.find((e) => e.id === d.id) ?? null);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id]);

  const timeAtY = (clientY: number) => {
    const rect = colRef.current!.getBoundingClientRect();
    return day + snap(((clientY - rect.top) / PPM) * MIN);
  };

  // Native drag & drop from the "Add" sidebar onto the timeline.
  const onDrop = (ev: React.DragEvent) => {
    ev.preventDefault();
    const raw = ev.dataTransfer.getData('application/x-dial');
    if (!raw) return;
    const { kind, id } = JSON.parse(raw) as { kind: 'game' | 'program'; id: string };
    let e: ScheduleEntry | undefined;
    if (kind === 'game' && games[id]) e = entryFromGame(games[id], undefined, 10);
    const p = kind === 'program' ? programs.find((x) => x.id === id) : undefined;
    if (p) e = entryFromProgram(p, undefined, 5);
    if (!e) return;
    // Games and shows keep their real air times; dropping just adds them.
    const entry = e;
    update((st) => ({ schedule: st.schedule.some((x) => x.id === entry.id) ? st.schedule : [...st.schedule, entry] }));
  };

  const newBlock = (ev: React.MouseEvent) => {
    if (ev.target !== colRef.current) return;
    const start = timeAtY(ev.clientY);
    setEditing({ id: `custom:${Date.now()}`, title: '', start, end: start + HOUR, reminderMin: 10 });
  };

  const days = Array.from({ length: 8 }, (_, i) => startOfDay(startOfDay(Date.now()) + (i - 1) * 24 * HOUR + 2 * HOUR));
  const upcomingConflicts = [...conflicts.keys()].length;

  const suggestions = useMemo(() => {
    const gs = Object.values(games).filter((g) => g.state !== 'post' && g.start >= day && g.start < dayEnd).sort((a, b) => a.start - b.start).slice(0, 30);
    const progs = programs.filter((p) => p.end > Math.max(now, day) && p.start < dayEnd && (p.isSports || p.isNew)).slice(0, 20);
    return { games: gs, progs };
  }, [games, programs, day, dayEnd, now]);

  return (
    <div className="schedulePage">
      <div className="guideBar">
        <div className="chips">
          <button className={tab === 'smart' ? 'on' : ''} onClick={() => setTab('smart')}><Sparkles /> Smart plan</button>
          <button className={tab === 'day' ? 'on' : ''} onClick={() => setTab('day')}>Day</button>
          <button className={tab === 'agenda' ? 'on' : ''} onClick={() => setTab('agenda')}>Agenda</button>
          <button className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}><Repeat /> Rules ({rulesCount})</button>
        </div>
        {tab === 'day' && <div className="chips">{days.map((d) => <button key={d} className={d === day ? 'on' : ''} onClick={() => setDay(d)}>{fmtDay(d)}</button>)}</div>}
      </div>
      {tab === 'smart' && <SmartPlanner />}
      {upcomingConflicts > 0 && tab !== 'smart' && (
        <div className="banner warn"><AlertTriangle /> {upcomingConflicts} upcoming items overlap. Overlapping blocks are shown side by side — consider Multiview for simultaneous games.</div>
      )}

      {tab === 'day' && (
        <div className="schedGrid">
          <div className="timeline" ref={scrollRef}>
            <div className="tlInner" style={{ height: DAY_MIN * PPM }}>
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="tlHour" style={{ top: h * 60 * PPM }}><span>{fmtTime(day + h * HOUR)}</span></div>
              ))}
              <div className="tlCol" ref={colRef} onDoubleClick={newBlock} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} title="Double-click to add a block">
                {now >= day && now < dayEnd && <div className="tlNow" style={{ top: ((now - day) / MIN) * PPM }} />}
                {entries.map((e) => {
                  const l = lanes.get(e.id) ?? { lane: 0, lanes: 1 };
                  const top = ((Math.max(e.start, day) - day) / MIN) * PPM;
                  const h = Math.max(18, ((Math.min(e.end, dayEnd) - Math.max(e.start, day)) / MIN) * PPM);
                  const conflict = conflicts.has(e.id);
                  return (
                    <div
                      key={e.id}
                      className={`block ${conflict ? 'conflict' : ''} ${e.color ?? ''} ${e.eventId ? 'game' : ''} ${drag?.id === e.id ? 'dragging' : ''}`}
                      style={{ top, height: h, left: `calc(${(l.lane / l.lanes) * 100}% + 2px)`, width: `calc(${100 / l.lanes}% - 4px)` }}
                      onPointerDown={(ev) => { ev.preventDefault(); setDrag({ id: e.id, mode: 'move', y0: ev.clientY, start: e.start, end: e.end, moved: false }); }}
                      tabIndex={0}
                      role="button"
                      aria-label={`${e.title}, ${fmtTime(e.start)} to ${fmtTime(e.end)}. Press Enter to edit`}
                      onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setEditing(e); } }}
                    >
                      <b>{e.title}</b>
                      <small>{fmtTime(e.start)} – {fmtTime(e.end)}{e.reminderMin != null && <Bell />}{conflict && <AlertTriangle />}</small>
                      <span
                        className="resize"
                        onPointerDown={(ev) => { ev.preventDefault(); ev.stopPropagation(); setDrag({ id: e.id, mode: 'resize', y0: ev.clientY, start: e.start, end: e.end, moved: false }); }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <aside className="addSide">
            <h3 className="sectionTitle">DRAG ONTO YOUR DAY</h3>
            <button className="ghost" onClick={() => setEditing({ id: `custom:${Date.now()}`, title: '', start: snap(Math.max(now, day + 19 * HOUR)), end: snap(Math.max(now, day + 19 * HOUR)) + HOUR, reminderMin: 10 })}><Plus /> Custom block</button>
            {suggestions.games.map((g) => (
              <div key={g.id} className="sugg" draggable onDragStart={(e) => e.dataTransfer.setData('application/x-dial', JSON.stringify({ kind: 'game', id: g.id }))}
                onDoubleClick={() => update((st) => ({ schedule: st.schedule.some((x) => x.eventId === g.id) ? st.schedule : [...st.schedule, entryFromGame(g, undefined, 10)] }))}>
                <b>{g.away.abbr} @ {g.home.abbr}</b><small>{leagueLabel(g.league)} · {fmtTime(g.start)} · {g.broadcasts[0] ?? 'TBD'}</small>
              </div>
            ))}
            {suggestions.progs.map((p) => (
              <div key={p.id} className="sugg" draggable onDragStart={(e) => e.dataTransfer.setData('application/x-dial', JSON.stringify({ kind: 'program', id: p.id }))}>
                <b>{p.title}</b><small>{fmtTime(p.start)} · {channels.find((c) => c.id === p.channelId)?.name}</small>
              </div>
            ))}
            {!suggestions.games.length && !suggestions.progs.length && <p className="muted small">No games or highlighted shows for this day.</p>}
          </aside>
        </div>
      )}

      {tab === 'agenda' && <Agenda onEdit={setEditing} conflicts={conflicts} />}
      {tab === 'rules' && <Rules />}
      {editing && <EditEntry entry={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Agenda({ onEdit, conflicts }: { onEdit: (e: ScheduleEntry) => void; conflicts: Map<string, string[]> }) {
  const schedule = useApp((s) => s.schedule);
  const upcoming = schedule.filter((e) => e.end > Date.now()).sort((a, b) => a.start - b.start);
  let lastDay = '';
  if (!upcoming.length) return <p className="muted">Nothing upcoming. Add games from Sports, shows from the Guide, or set up rules.</p>;
  return (
    <div className="agenda">
      {upcoming.map((e) => {
        const d = fmtDay(e.start);
        const head = d !== lastDay ? <h3 className="sectionTitle" key={'h' + d}>{d.toUpperCase()}</h3> : null;
        lastDay = d;
        return (
          <div key={e.id}>
            {head}
            <button className={`agendaRow ${conflicts.has(e.id) ? 'conflict' : ''}`} onClick={() => onEdit(e)}>
              <time>{fmtTime(e.start)}</time>
              <div><b>{e.title}</b><small>{e.notes}</small></div>
              {e.ruleId && <Repeat />}
              {e.reminderMin != null && <Bell />}
              {conflicts.has(e.id) && <AlertTriangle />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function EditEntry({ entry, onClose }: { entry: ScheduleEntry; onClose: () => void }) {
  const exists = useApp((s) => s.schedule.some((x) => x.id === entry.id));
  const update = useApp((s) => s.update);
  const { channels, channelOrder, hidden } = useApp(useShallow((s) => ({ channels: s.channels, channelOrder: s.channelOrder, hidden: s.hidden })));
  const healthDeps = useHealthDeps();
  const chOptions = useMemo(() => orderedChannels({ channels, channelOrder, hidden }).map((c) => ({ id: c.id, label: `${c.number} · ${c.name}` })), [channels, channelOrder, hidden, ...healthDeps]); // eslint-disable-line react-hooks/exhaustive-deps
  const [e, setE] = useState(entry);
  const toLocalInput = (ms: number) => {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * MIN);
    return d.toISOString().slice(0, 16);
  };
  const dur = Math.round((e.end - e.start) / MIN);
  const save = () => {
    if (!e.title.trim()) return;
    update((st) => ({ schedule: exists ? st.schedule.map((x) => (x.id === e.id ? e : x)) : [...st.schedule, e] }));
    onClose();
  };
  const del = () => {
    update((st) => ({ schedule: st.schedule.filter((x) => x.id !== e.id), dismissed: e.ruleId ? [...st.dismissed, e.id] : st.dismissed }));
    onClose();
  };
  return (
    <Modal title={exists ? 'Edit' : 'New block'} onClose={onClose}>
      <form className="form" onSubmit={(ev) => { ev.preventDefault(); save(); }}>
        <label>Title<input className="field" autoFocus value={e.title} onChange={(x) => setE({ ...e, title: x.target.value })} /></label>
        <div className="row">
          <label>Start<input className="field" type="datetime-local" value={toLocalInput(e.start)} onChange={(x) => { const st = new Date(x.target.value).getTime(); if (Number.isFinite(st)) setE({ ...e, start: st, end: st + (e.end - e.start) }); }} /></label>
          <label>Minutes<input className="field" type="number" min={15} step={15} value={dur} onChange={(x) => setE({ ...e, end: e.start + Math.max(15, +x.target.value) * MIN })} /></label>
        </div>
        <div className="label" role="group" aria-label="Channel">Channel
          <ChannelPicker value={e.channelId} options={chOptions} placeholder="Auto (from game broadcast) / none" noneLabel="Auto (from game broadcast) / none" onChange={(id) => setE({ ...e, channelId: id })} />
        </div>
        <label>Reminder
          <select className="field" value={e.reminderMin ?? ''} onChange={(x) => setE({ ...e, reminderMin: x.target.value === '' ? undefined : +x.target.value })}>
            <option value="">None</option>
            {[0, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m ? `${m} min before` : 'At start'}</option>)}
          </select>
        </label>
        <label>Notes<textarea className="field" rows={3} value={e.notes ?? ''} onChange={(x) => setE({ ...e, notes: x.target.value })} /></label>
        <div className="row">
          {exists && <button type="button" className="ghost danger" onClick={del}><Trash2 /> Delete</button>}
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!e.title.trim()}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

function Rules() {
  const rules = useApp((s) => s.rules);
  const update = useApp((s) => s.update);
  const [kind, setKind] = useState<ScheduleRule['kind']>('title');
  const [match, setMatch] = useState('');
  const [startMin, setStartMin] = useState(19 * 60);
  const [endMin, setEndMin] = useState(22 * 60);
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const parse = (v: string) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };

  const add = () => {
    const r: ScheduleRule = { id: `r${Date.now()}`, kind, match: match.trim(), enabled: true, reminderMin: kind === 'block' ? undefined : 10, ...(kind === 'block' ? { startMin, endMin, days } : {}) };
    if (!r.match && kind !== 'block') return;
    if (kind === 'block' && !r.match) r.match = 'Reserved';
    update((st) => ({ rules: [...st.rules, r] }));
    setMatch('');
    setTimeout(addRuleEntries, 0);
  };
  const describe = (r: ScheduleRule) =>
    r.kind === 'team' ? `Add every ${r.match.split(':')[0].toUpperCase()} ${r.match.split(':')[1]} game`
      : r.kind === 'title' ? `Add every airing of “${r.match}”`
        : `Reserve ${hhmm(r.startMin ?? 0)}–${hhmm(r.endMin ?? 0)} for “${r.match}” on ${(r.days ?? []).map((d) => 'SMTWTFS'[d]).join('')}`;

  return (
    <div className="rules">
      <p className="muted">Rules add entries to your schedule automatically for the coming week. They never record anything — they just plan and remind.</p>
      {rules.map((r) => (
        <div key={r.id} className="ruleRow">
          <Toggle on={r.enabled} label={`Enable rule: ${describe(r)}`} onChange={(v) => update((st) => ({ rules: st.rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)) }))} />
          <span>{describe(r)}</span>
          <button className="icon" aria-label="Delete rule" onClick={() => update((st) => ({ rules: st.rules.filter((x) => x.id !== r.id), schedule: st.schedule.filter((e) => e.ruleId !== r.id || e.start < Date.now()) }))}><Trash2 /></button>
        </div>
      ))}
      <div className="panel">
        <h3 className="sectionTitle">NEW RULE</h3>
        <div className="chips">
          <button className={kind === 'title' ? 'on' : ''} onClick={() => setKind('title')}>Show title</button>
          <button className={kind === 'block' ? 'on' : ''} onClick={() => setKind('block')}>Time block</button>
          <span className="muted small">Team rules: My Teams → Edit teams → calendar icon</span>
        </div>
        <div className="row">
          <input className="field" placeholder={kind === 'title' ? 'e.g. SportsCenter' : 'Label, e.g. Prime time'} value={match} onChange={(e) => setMatch(e.target.value)} />
          {kind === 'block' && (
            <>
              <input className="field small" type="time" value={hhmm(startMin)} onChange={(e) => setStartMin(parse(e.target.value))} />
              <input className="field small" type="time" value={hhmm(endMin)} onChange={(e) => setEndMin(parse(e.target.value))} />
            </>
          )}
          <button className="primary" onClick={add}>Add rule</button>
        </div>
        {kind === 'block' && (
          <div className="chips">{'SMTWTFS'.split('').map((d, i) => <button key={i} className={days.includes(i) ? 'on' : ''} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}>{d}</button>)}</div>
        )}
      </div>
    </div>
  );
}
