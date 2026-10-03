import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CalendarPlus, Check, Clock, Play, Repeat, Trophy } from 'lucide-react';
import { orderedChannels, useApp } from '../store/app';
import { Drawer, fmtDay, fmtTime } from '../components/ui';
import { entryFromProgram, HOUR, MIN, startOfDay } from '../lib/scheduler';
import { navigate, replaceRoute, useRoute } from '../app/router';
import { useShallow } from 'zustand/react/shallow';
import type { Program } from '../types';
import { useTv } from '../store/tv';
import { asChannel, personalPrograms, TvMark, usePersonalChannels } from '../components/tv/personal';

const ZOOM_PX: Record<30 | 60 | 120, number> = { 30: 9, 60: 5, 120: 3 }; // px per minute
const CH_COL = 190;
const ROW_H = 64;

const paramTime = (param?: string) => (param && Number.isFinite(+param) && +param > 0 ? +param : undefined);

export default function GuidePage() {
  const { channels: allChannels, channelOrder, hidden } = useApp(useShallow((s) => ({ channels: s.channels, channelOrder: s.channelOrder, hidden: s.hidden })));
  const programs = useApp((s) => s.programs);
  const schedule = useApp((s) => s.schedule);
  const zoom = useApp((s) => s.settings.guideZoom);
  const update = useApp((s) => s.update);
  const { param } = useRoute();
  const ppm = ZOOM_PX[zoom];
  const personalDefs = useTv((s) => s.personal);
  const durations = useTv((s) => s.durations);
  const personalChannels = usePersonalChannels();
  // Live channels only (no movies/episodes), then My Channels.
  const channels = useMemo(() => [...orderedChannels({ channels: allChannels, channelOrder, hidden }), ...personalChannels], [allChannels, channelOrder, hidden, personalChannels]);
  const [day, setDay] = useState(() => startOfDay(paramTime(param) ?? Date.now()));
  // One-shot scroll target (route param or "Now"); consumed by the layout effect below.
  const pendingJump = useRef<number | undefined>(paramTime(param));
  const [jumpSeq, setJumpSeq] = useState(0);
  const [sel, setSel] = useState<Program | null>(null);
  const [sportsOnly, setSportsOnly] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const dayEnd = startOfDay(day + 26 * HOUR);
  const width = ((dayEnd - day) / MIN) * ppm;

  const byChannel = useMemo(() => {
    const m = new Map<string, Program[]>();
    for (const p of programs) {
      if (p.end <= day || p.start >= dayEnd) continue;
      if (sportsOnly && !p.isSports) continue;
      const arr = m.get(p.channelId);
      if (arr) arr.push(p);
      else m.set(p.channelId, [p]);
    }
    if (!sportsOnly) for (const p of personalDefs) m.set(asChannel(p).id, personalPrograms(p, durations, day, dayEnd));
    for (const arr of m.values()) arr.sort((a, b) => a.start - b.start);
    return m;
  }, [programs, day, dayEnd, sportsOnly, personalDefs, durations]);

  const rows = sportsOnly ? channels.filter((c) => byChannel.has(c.id)) : channels;

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

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

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => setView({ left: el.scrollLeft, width: el.clientWidth }));
  };
  useEffect(onScroll, []);

  // Visible time window (+buffer) for horizontal culling.
  const visFrom = day + ((view.left - 400) / ppm) * MIN;
  const visTo = day + ((view.left + view.width + 400) / ppm) * MIN;

  const slotMin = zoom === 120 ? 60 : 30;
  const slots: number[] = [];
  for (let t = day; t < dayEnd; t += slotMin * MIN) slots.push(t);

  const days = Array.from({ length: 8 }, (_, i) => startOfDay(startOfDay(Date.now()) + (i - 1) * 24 * HOUR + 2 * HOUR));
  const scheduledIds = useMemo(() => new Set(schedule.map((e) => e.programId)), [schedule]);

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
        </div>
      </div>

      <div className="grid" ref={scrollRef} onScroll={onScroll}>
        <div style={{ width: CH_COL + width, height: virt.getTotalSize() + 36, position: 'relative' }}>
          <div className="gHead" style={{ width: CH_COL + width }}>
            <div className="gCorner" style={{ width: CH_COL }}>{fmtDay(day)}</div>
            {slots.map((t) => (
              <div key={t} className="gSlot" style={{ left: CH_COL + ((t - day) / MIN) * ppm, width: slotMin * ppm }}>{fmtTime(t)}</div>
            ))}
          </div>
          {now >= day && now < dayEnd && <div className="nowLine" style={{ left: CH_COL + ((now - day) / MIN) * ppm, height: virt.getTotalSize() + 36 }} />}
          {virt.getVirtualItems().map((vr) => {
            const c = rows[vr.index];
            const progs = (byChannel.get(c.id) ?? []).filter((p) => p.end > visFrom && p.start < visTo);
            return (
              <div key={c.id} className="gRow" style={{ top: 36 + vr.start, height: ROW_H, width: CH_COL + width }}>
                <button className="gCh" style={{ width: CH_COL }} onClick={() => { useApp.getState().tune(c.id); navigate('watch'); }}>
                  <TvMark channel={c} size={34} /><div><small>{c.number}</small><b>{c.name}</b></div>
                </button>
                {progs.map((p) => {
                  const left = CH_COL + ((Math.max(p.start, day) - day) / MIN) * ppm;
                  const w = ((Math.min(p.end, dayEnd) - Math.max(p.start, day)) / MIN) * ppm;
                  const live = p.start <= now && p.end > now;
                  // Keep the title visible when the block starts left of the viewport.
                  const pad = Math.max(0, Math.min(view.left + CH_COL - left, w - 80));
                  return (
                    <button
                      key={p.id}
                      className={`gProg ${live ? 'live' : ''} ${p.end <= now ? 'past' : ''} ${p.isSports ? 'sports' : ''} ${scheduledIds.has(p.id) ? 'sched' : ''}`}
                      style={{ left, width: Math.max(2, w - 2), paddingLeft: 8 + pad }}
                      onClick={() => setSel(p)}
                      title={`${p.title} · ${fmtTime(p.start)}–${fmtTime(p.end)}`}
                    >
                      <b>{p.title}</b>
                      {w > 90 && <span>{fmtTime(p.start)}{p.isNew ? ' · NEW' : ''}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {!rows.length && <p className="muted">{sportsOnly ? 'No sports programming found in the guide for this day.' : 'No channels yet. Add your playlist on the Watch page or in Settings.'}</p>}
      {sel && <ProgramDrawer p={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function ProgramDrawer({ p, onClose }: { p: Program; onClose: () => void }) {
  const liveCh = useApp((s) => s.channels.find((c) => c.id === p.channelId));
  const personal = useTv((s) => s.personal.find((x) => p.channelId === `my:${x.id}`));
  const ch = liveCh ?? (personal ? asChannel(personal) : undefined);
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
