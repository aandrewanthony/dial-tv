import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CalendarPlus, Check, Clock, Download, Heart, Loader2, Play, RefreshCw, Repeat, Search, Trophy, X } from 'lucide-react';
import { channelGroups, orderedChannels, programsByChannel, useApp } from '../store/app';
import { Drawer, fmtDay, fmtTime } from '../components/ui';
import { entryFromProgram, HOUR, MIN, startOfDay } from '../lib/scheduler';
import { navigate, replaceRoute, useRoute } from '../app/router';
import { useShallow } from 'zustand/react/shallow';
import type { Channel, Program } from '../types';
import { useTv } from '../store/tv';
import { asChannel, personalPrograms, TvMark, usePersonalChannels } from '../components/tv/personal';
import { cancelGuideLoad, guideProgressText, guideStatusText, loadGuide, useGuide } from '../store/guide';

const ZOOM_PX: Record<30 | 60 | 120, number> = { 30: 9, 60: 5, 120: 3 }; // px per minute
const CH_COL = 190;
const ROW_H = 64;
/** Rows without listings for the day are compact. */
const ROW_EMPTY = 38;
const HEAD_H = 36;

const paramTime = (param?: string) => (param && Number.isFinite(+param) && +param > 0 ? +param : undefined);

/** Index of the first program that ends after `t` in a start-sorted list (lists are non-overlapping after parsing). */
function firstEndingAfter(list: Program[], t: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Programs of a sorted list overlapping [from, to). */
function slice(list: Program[] | undefined, from: number, to: number): Program[] {
  if (!list?.length) return [];
  const out: Program[] = [];
  for (let i = firstEndingAfter(list, from); i < list.length && list[i].start < to; i++) if (list[i].end > from) out.push(list[i]);
  return out;
}

/**
 * Guide status + Load/Refresh button + progress bar. Used on the Guide page, in Settings and
 * (compact) wherever the guide's state matters.
 */
export function GuideStatus({ compact = false }: { compact?: boolean }) {
  const g = useGuide();
  const hasSource = useApp((s) => s.epgSources.some((e) => e.enabled));
  const prog = guideProgressText(g.progress);
  return (
    <div className={`guideStatus ${compact ? 'compact' : ''}`} role="status" aria-label="Guide status">
      {g.loading ? (
        <>
          <div className="guideStatusText"><Loader2 className="spin" /> <span>{prog.text || 'Loading guide…'}</span></div>
          <div className="gProgress" aria-label="Guide loading progress"><i style={prog.fraction != null ? { width: `${Math.round(prog.fraction * 100)}%` } : undefined} className={prog.fraction == null ? 'indet' : ''} /></div>
          <button className="ghost" onClick={cancelGuideLoad}><X /> Cancel</button>
        </>
      ) : (
        <>
          <div className="guideStatusText">
            <span data-guide-status>{guideStatusText(g)}</span>
            {g.loaded && g.needsReload > 0 && <small className="warn"> · {g.needsReload} newly mapped channel{g.needsReload > 1 ? 's' : ''} need a refresh</small>}
            {g.error && <small className="err">{g.error}</small>}
          </div>
          {hasSource && (
            <button className={g.loaded ? 'ghost' : 'primary'} onClick={() => void loadGuide()}>
              {g.loaded ? <><RefreshCw /> Refresh guide</> : <><Download /> Load guide</>}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function GuidePage() {
  const { channels: allChannels, channelOrder, hidden, favorites } = useApp(useShallow((s) => ({ channels: s.channels, channelOrder: s.channelOrder, hidden: s.hidden, favorites: s.favorites })));
  const programs = useApp((s) => s.programs);
  const schedule = useApp((s) => s.schedule);
  const zoom = useApp((s) => s.settings.guideZoom);
  const hasSource = useApp((s) => s.epgSources.some((e) => e.enabled));
  const update = useApp((s) => s.update);
  const guide = useGuide(useShallow((s) => ({ loaded: s.loaded, loading: s.loading, ready: s.ready, days: s.days })));
  const { param } = useRoute();
  const ppm = ZOOM_PX[zoom];
  const personalDefs = useTv((s) => s.personal);
  const durations = useTv((s) => s.durations);
  const personalChannels = usePersonalChannels();
  const live = useMemo(() => orderedChannels({ channels: allChannels, channelOrder, hidden }), [allChannels, channelOrder, hidden]);
  const groups = useMemo(() => channelGroups({ channels: allChannels, channelOrder, hidden }).filter((g) => !g.hidden), [allChannels, channelOrder, hidden]);
  const [day, setDay] = useState(() => startOfDay(paramTime(param) ?? Date.now()));
  // One-shot scroll target (route param or "Now"); consumed by the layout effect below.
  const pendingJump = useRef<number | undefined>(paramTime(param));
  const [jumpSeq, setJumpSeq] = useState(0);
  const [sel, setSel] = useState<{ p: Program; ch?: Channel } | null>(null);
  const [sportsOnly, setSportsOnly] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const [group, setGroup] = useState('');
  const [q, setQ] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const dayEnd = startOfDay(day + 26 * HOUR);
  const width = ((dayEnd - day) / MIN) * ppm;

  const index = programsByChannel(programs);
  // Personal channels compute their own listings (once per day).
  const personalByDay = useMemo(() => {
    const m = new Map<string, Program[]>();
    for (const p of personalDefs) m.set(asChannel(p).id, personalPrograms(p, durations, day, dayEnd));
    return m;
  }, [personalDefs, durations, day, dayEnd]);
  const listOf = (id: string) => personalByDay.get(id) ?? index.get(id);

  const rows = useMemo(() => {
    const favs = new Set(favorites);
    const n = q.trim().toLowerCase();
    const base: Channel[] = [...live.filter((c) => (!group || c.groupKey === group) && (!favOnly || favs.has(c.id) || c.memberIds?.some((m) => favs.has(m)))), ...(group || favOnly ? [] : personalChannels)];
    return base.filter((c) => {
      if (n && !c.name.toLowerCase().includes(n) && String(c.number) !== n) return false;
      if (sportsOnly) {
        const l = personalByDay.get(c.id) ?? index.get(c.id);
        if (!l || !slice(l, day, dayEnd).some((p) => p.isSports)) return false;
      }
      return true;
    });
  }, [live, personalChannels, group, favOnly, favorites, q, sportsOnly, personalByDay, index, day, dayEnd]);

  // Which rows have listings today (compact "No listings" rows otherwise).
  const filled = useMemo(() => rows.map((c) => slice(listOf(c.id), day, dayEnd).length > 0), [rows, index, personalByDay, day, dayEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (filled[i] ? ROW_H : ROW_EMPTY),
    getItemKey: (i) => rows[i]?.id ?? i,
    overscan: 8,
  });
  useEffect(() => virt.measure(), [filled]); // eslint-disable-line react-hooks/exhaustive-deps

  const jumpTo = (t: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, ((t - day) / MIN) * ppm - 120);
  };

  // Scroll to the pending target (param / "Now"), else to now or prime time, on open / zoom / day change.
  useLayoutEffect(() => {
    const t = Date.now();
    const target = pendingJump.current ?? (t >= day && t < dayEnd ? t : day + 18 * HOUR);
    pendingJump.current = undefined;
    jumpTo(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, ppm, jumpSeq]);

  // A time in the route (e.g. from search) is consumed once, then dropped so it can't hijack later day/zoom changes.
  useEffect(() => {
    const t = paramTime(param);
    if (t == null) return;
    pendingJump.current = t;
    setDay(startOfDay(t));
    setJumpSeq((x) => x + 1);
    replaceRoute('guide');
  }, [param]);

  const goNow = () => {
    const t = Date.now();
    setNow(t);
    pendingJump.current = t;
    setDay(startOfDay(t));
    setJumpSeq((x) => x + 1);
  };

  // Horizontal position in coarse steps: rows only re-render when the visible time block changes.
  const raf = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const left = Math.floor(el.scrollLeft / 240) * 240;
      setView((v) => (v.left === left && v.width === el.clientWidth ? v : { left, width: el.clientWidth }));
    });
  };
  useEffect(onScroll, []);

  // Visible time window, padded and snapped to 2-hour blocks: only programmes in it are rendered.
  const BLOCK = 2 * HOUR;
  const visFrom = Math.max(day, Math.floor((day + ((view.left - CH_COL) / ppm) * MIN - HOUR) / BLOCK) * BLOCK);
  const visTo = Math.min(dayEnd, Math.ceil((day + ((view.left + view.width + 240) / ppm) * MIN + HOUR) / BLOCK) * BLOCK);

  const slotMin = zoom === 120 ? 60 : 30;
  const visSlots: number[] = [];
  for (let t = day; t < dayEnd; t += slotMin * MIN) if (t + slotMin * MIN > visFrom && t < visTo) visSlots.push(t);
  const onSelect = useCallback((p: Program, ch: Channel) => setSel({ p, ch }), []);

  const dayCount = (guide.loaded && guide.days ? guide.days : 7) + 2;
  const days = Array.from({ length: dayCount }, (_, i) => startOfDay(startOfDay(Date.now()) + (i - 1) * 24 * HOUR + 2 * HOUR));
  const scheduledIds = useMemo(() => new Set(schedule.map((e) => e.programId)), [schedule]);
  const total = virt.getTotalSize();

  return (
    <div className="guidePage">
      <div className="guideBar">
        <div className="chips">
          {days.map((d) => <button key={d} className={d === day ? 'on' : ''} onClick={() => setDay(d)}>{fmtDay(d)}</button>)}
        </div>
        <div className="chips">
          <button onClick={goNow}><Clock /> Now</button>
          {([30, 60, 120] as const).map((z) => (
            <button key={z} className={zoom === z ? 'on' : ''} onClick={() => update((st) => ({ settings: { ...st.settings, guideZoom: z } }))}>{z === 120 ? '2 hr' : `${z} min`}</button>
          ))}
          <button className={sportsOnly ? 'on' : ''} onClick={() => setSportsOnly(!sportsOnly)}><Trophy /> Sports</button>
          <button className={favOnly ? 'on' : ''} onClick={() => setFavOnly(!favOnly)} aria-pressed={favOnly}><Heart /> Favorites</button>
        </div>
      </div>
      <div className="guideFilters">
        <label className="guideSearch"><Search /><input placeholder="Filter channels" aria-label="Filter channels" value={q} onChange={(e) => setQ(e.target.value)} />{q && <button className="icon" aria-label="Clear filter" onClick={() => setQ('')}><X /></button>}</label>
        <select className="field guideGroup" aria-label="Channel group" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">All groups</option>
          {groups.map((g) => <option key={g.key} value={g.key}>{g.label} ({g.count})</option>)}
        </select>
        {hasSource && <GuideStatus compact />}
      </div>

      {guide.ready && !guide.loaded && !guide.loading && (live.length > 0 || hasSource) && (
        <div className="guideCta">
          {hasSource ? (
            <>
              <div><b>Your guide isn’t loaded yet</b><span>Listings download only when you ask, then load instantly from this device. Change automatic refresh in Settings → Sources.</span></div>
              <button className="primary" onClick={() => void loadGuide()}><Download /> Load guide</button>
            </>
          ) : (
            <>
              <div><b>No guide source</b><span>Add your provider’s XMLTV (EPG) link in Settings to see what’s on.</span></div>
              <button onClick={() => navigate('settings', 'sources')}>Open Settings</button>
            </>
          )}
        </div>
      )}

      <div className="grid" ref={scrollRef} onScroll={onScroll}>
        <div style={{ width: CH_COL + width, height: total + HEAD_H, position: 'relative' }}>
          <div className="gHead" style={{ width: CH_COL + width }}>
            <div className="gCorner" style={{ width: CH_COL }}>{fmtDay(day)}</div>
            {visSlots.map((t) => (
              <div key={t} className="gSlot" style={{ left: CH_COL + ((t - day) / MIN) * ppm, width: slotMin * ppm }}>{timeLabel(t)}</div>
            ))}
          </div>
          {now >= day && now < dayEnd && <div className="nowLine" style={{ left: CH_COL + ((now - day) / MIN) * ppm, height: total + HEAD_H }} />}
          {virt.getVirtualItems().map((vr) => {
            const c = rows[vr.index];
            if (!c) return null;
            const has = filled[vr.index];
            return (
              <GuideRow
                key={c.id}
                c={c}
                list={has ? listOf(c.id) : undefined}
                top={HEAD_H + vr.start}
                width={CH_COL + width}
                from={visFrom}
                to={visTo}
                day={day}
                dayEnd={dayEnd}
                ppm={ppm}
                now={now}
                scheduledIds={scheduledIds}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      </div>
      {!rows.length && (
        <p className="muted">
          {q || group || favOnly ? 'No channels match these filters.' : sportsOnly ? 'No sports programming found in the guide for this day.' : 'No channels yet. Add your playlist on the Watch page or in Settings.'}
        </p>
      )}
      {sel && <ProgramDrawer p={sel.p} rowChannel={sel.ch} onClose={() => setSel(null)} />}
    </div>
  );
}

const timeCache = new Map<number, string>();
/** fmtTime with a cache: guide blocks share a handful of start times and Intl formatting is slow. */
function timeLabel(t: number) {
  let v = timeCache.get(t);
  if (v == null) {
    if (timeCache.size > 5000) timeCache.clear();
    v = fmtTime(t);
    timeCache.set(t, v);
  }
  return v;
}

interface RowProps {
  c: Channel;
  /** Listings (sorted), or undefined for a compact "No listings" row. */
  list?: Program[];
  top: number;
  width: number;
  from: number;
  to: number;
  day: number;
  dayEnd: number;
  ppm: number;
  now: number;
  scheduledIds: Set<string | undefined>;
  onSelect: (p: Program, c: Channel) => void;
}

/** One guide row; memoized so scrolling only renders rows that come into view. */
const GuideRow = memo(function GuideRow({ c, list, top, width, from, to, day, dayEnd, ppm, now, scheduledIds, onSelect }: RowProps) {
  const progs = list ? slice(list, from, to) : [];
  return (
    <div className={`gRow ${list ? '' : 'gRowEmpty'}`} style={{ top, height: list ? ROW_H : ROW_EMPTY, width }}>
      <button className="gCh" style={{ width: CH_COL }} onClick={() => { useApp.getState().tune(c.id); navigate('watch'); }}>
        <TvMark channel={c} size={list ? 34 : 24} /><div><small>{c.number}</small><b>{c.name}</b></div>
      </button>
      {!list && <span className="gNoList">No listings</span>}
      {progs.map((p) => {
        const left = CH_COL + ((Math.max(p.start, day) - day) / MIN) * ppm;
        const w = ((Math.min(p.end, dayEnd) - Math.max(p.start, day)) / MIN) * ppm;
        const isLiveNow = p.start <= now && p.end > now;
        return (
          <button
            key={p.id}
            className={`gProg ${isLiveNow ? 'live' : ''} ${p.end <= now ? 'past' : ''} ${p.isSports ? 'sports' : ''} ${scheduledIds.has(p.id) ? 'sched' : ''}`}
            style={{ left, width: Math.max(2, w - 2) }}
            onClick={() => onSelect(p, c)}
            title={p.title}
          >
            <b>{p.title}</b>
            {w > 90 && <span>{timeLabel(p.start)}{p.isNew ? ' · NEW' : ''}</span>}
          </button>
        );
      })}
    </div>
  );
});

function ProgramDrawer({ p, rowChannel, onClose }: { p: Program; rowChannel?: Channel; onClose: () => void }) {
  const liveCh = useApp((s) => (rowChannel ? undefined : s.channels.find((c) => c.id === p.channelId)));
  const personal = useTv((s) => s.personal.find((x) => p.channelId === `my:${x.id}`));
  const ch = rowChannel ?? liveCh ?? (personal ? asChannel(personal) : undefined);
  const entryId = `prog:${p.id}`;
  const scheduled = useApp((s) => s.schedule.some((e) => e.id === entryId));
  const ruleExists = useApp((s) => s.rules.some((r) => r.kind === 'title' && r.match.toLowerCase() === p.title.toLowerCase()));
  const update = useApp((s) => s.update);
  const live = p.start <= Date.now() && p.end > Date.now();
  const toggle = () => update((st) => {
    if (!scheduled) return { schedule: [...st.schedule, entryFromProgram(p, undefined, 5)] };
    // Rule-generated entries are remembered as dismissed so rules don't re-add them.
    const ruled = st.schedule.some((e) => e.id === entryId && e.ruleId);
    return { schedule: st.schedule.filter((e) => e.id !== entryId), dismissed: ruled ? [...st.dismissed, entryId] : st.dismissed };
  });
  return (
    <Drawer title={p.title} onClose={onClose}>
      <div className="pd">
        {p.subtitle && <h4>{p.subtitle}</h4>}
        <p className="muted">{fmtDay(p.start)} · {fmtTime(p.start)} – {fmtTime(p.end)} · {Math.round((p.end - p.start) / MIN)} min</p>
        <p className="muted">{ch?.name} · {p.category}{p.isNew ? ' · NEW' : ''}</p>
        {p.description && <p>{p.description}</p>}
        <div className="col">
          {live && ch && <button className="primary" onClick={() => { useApp.getState().tune(ch.id); navigate('watch'); }}><Play /> Watch now</button>}
          <button onClick={toggle}>
            {scheduled ? <><Check /> In your schedule</> : <><CalendarPlus /> Add to schedule (5-min reminder)</>}
          </button>
          <button disabled={ruleExists} onClick={() => update((st) => ({ rules: [...st.rules, { id: `r${Date.now()}`, kind: 'title', match: p.title, enabled: true, reminderMin: 5 }] }))}>
            <Repeat /> {ruleExists ? 'Rule exists' : `Add every “${p.title}”`}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
