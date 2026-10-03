import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CalendarPlus, Check, Clock, Play, Repeat, Trophy } from 'lucide-react';
import { orderedChannels, useApp } from '../store/app';
import { ChannelMark, Drawer, fmtDay, fmtTime } from '../components/ui';
import { entryFromProgram, HOUR, MIN, startOfDay } from '../lib/scheduler';
import { navigate, useRoute } from '../app/router';
import type { Program } from '../types';

const ZOOM_PX: Record<30 | 60 | 120, number> = { 30: 9, 60: 5, 120: 3 }; // px per minute
const CH_COL = 190;
const ROW_H = 64;

export default function GuidePage() {
  const s = useApp();
  const { param } = useRoute();
  const zoom = s.settings.guideZoom;
  const ppm = ZOOM_PX[zoom];
  const channels = useMemo(() => orderedChannels(s), [s.channels, s.channelOrder, s.hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  const [day, setDay] = useState(() => startOfDay(param ? +param || Date.now() : Date.now()));
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
    for (const p of s.programs) {
      if (p.end <= day || p.start >= dayEnd) continue;
      if (sportsOnly && !p.isSports) continue;
      const arr = m.get(p.channelId);
      if (arr) arr.push(p);
      else m.set(p.channelId, [p]);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.start - b.start);
    return m;
  }, [s.programs, day, dayEnd, sportsOnly]);

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

  // Scroll to "now" (or the requested time) on open / zoom / day change.
  useLayoutEffect(() => {
    const target = param && +param ? +param : now >= day && now < dayEnd ? now : day + 18 * HOUR;
    jumpTo(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, ppm]);

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
  const scheduledIds = new Set(s.schedule.map((e) => e.programId));

  return (
    <div className="guidePage">
      <div className="guideBar">
        <div className="chips">
          {days.map((d) => <button key={d} className={d === day ? 'on' : ''} onClick={() => setDay(d)}>{fmtDay(d)}</button>)}
        </div>
        <div className="chips">
          <button onClick={() => { setDay(startOfDay(Date.now())); setTimeout(() => jumpTo(Date.now()), 0); }}><Clock /> Now</button>
          {([30, 60, 120] as const).map((z) => (
            <button key={z} className={zoom === z ? 'on' : ''} onClick={() => s.update((st) => ({ settings: { ...st.settings, guideZoom: z } }))}>{z === 120 ? '2 hr' : `${z} min`}</button>
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
                <button className="gCh" style={{ width: CH_COL }} onClick={() => { s.tune(c.id); navigate('watch'); }}>
                  <ChannelMark channel={c} size={34} /><div><small>{c.number}</small><b>{c.name}</b></div>
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
  const s = useApp();
  const ch = s.channels.find((c) => c.id === p.channelId);
  const entryId = `prog:${p.id}`;
  const scheduled = s.schedule.some((e) => e.id === entryId);
  const live = p.start <= Date.now() && p.end > Date.now();
  const ruleExists = s.rules.some((r) => r.kind === 'title' && r.match.toLowerCase() === p.title.toLowerCase());
  return (
    <Drawer title={p.title} onClose={onClose}>
      <div className="pd">
        {p.subtitle && <h4>{p.subtitle}</h4>}
        <p className="muted">{fmtDay(p.start)} · {fmtTime(p.start)} – {fmtTime(p.end)} · {Math.round((p.end - p.start) / MIN)} min</p>
        <p className="muted">{ch?.name} · {p.category}{p.isNew ? ' · NEW' : ''}</p>
        {p.description && <p>{p.description}</p>}
        <div className="col">
          {live && ch && <button className="primary" onClick={() => { s.tune(ch.id); navigate('watch'); }}><Play /> Watch now</button>}
          <button onClick={() => s.update((st) => ({ schedule: scheduled ? st.schedule.filter((e) => e.id !== entryId) : [...st.schedule, entryFromProgram(p, undefined, 5)] }))}>
            {scheduled ? <><Check /> In your schedule</> : <><CalendarPlus /> Add to schedule (5-min reminder)</>}
          </button>
          <button disabled={ruleExists} onClick={() => s.update((st) => ({ rules: [...st.rules, { id: `r${Date.now()}`, kind: 'title', match: p.title, enabled: true, reminderMin: 5 }] }))}>
            <Repeat /> {ruleExists ? 'Rule exists' : `Add every “${p.title}”`}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
