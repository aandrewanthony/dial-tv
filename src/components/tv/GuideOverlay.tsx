import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bell, BellRing, CalendarPlus, Check, Play, X } from 'lucide-react';
import type { Channel, Program } from '../../types';
import { useApp } from '../../store/app';
import { useTv } from '../../store/tv';
import { entryFromProgram } from '../../lib/scheduler';
import { Modal, fmtDay, fmtTime, useNow } from '../ui';
import { programsFor, TvMark } from './personal';
import { leftLabel } from './InfoBanner';

const MIN = 60_000;
const HALF = 30 * MIN;
const SPAN = 4 * HALF; // 2 hours visible
const ROW_H = 54;
const floor30 = (t: number) => Math.floor(t / HALF) * HALF;

interface Props {
  rows: Channel[];
  currentId?: string;
  onTune: (id: string) => void;
  onClose: () => void;
}

/**
 * Cable-style grid guide that slides up over Live TV (the tuned channel keeps playing in the
 * corner preview). Arrows move the highlight, Enter tunes (on now) or opens details (later),
 * Esc / G closes.
 */
export function GuideOverlay({ rows, currentId, onTune, onClose }: Props) {
  const programs = useApp((s) => s.programs);
  const personal = useTv((s) => s.personal);
  const durations = useTv((s) => s.durations);
  const ctx = useMemo(() => ({ programs, personal, durations }), [programs, personal, durations]);
  const now = useNow(30_000);
  const [row, setRow] = useState(() => Math.max(0, rows.findIndex((c) => c.id === currentId)));
  const [cursor, setCursor] = useState(() => Date.now());
  const [ws, setWs] = useState(() => floor30(Date.now()));
  const [detail, setDetail] = useState<Program | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 6 });

  // Programs per visible row are computed lazily and cached per window.
  const cache = useMemo(() => new Map<string, Program[]>(), [ctx, ws]);
  const progsOf = (id: string) => {
    let v = cache.get(id);
    if (!v) cache.set(id, (v = programsFor(id, ws, ws + SPAN, ctx)));
    return v;
  };
  const progsAround = useCallback((id: string, t: number) => programsFor(id, t - 12 * 3600_000, t + 12 * 3600_000, ctx), [ctx]);

  const ch = rows[Math.min(row, rows.length - 1)];
  const sel = useMemo(() => (ch ? progsAround(ch.id, cursor).find((p) => p.start <= cursor && p.end > cursor) : undefined), [ch, cursor, progsAround]);

  // Keep the cursor inside the visible window.
  const moveCursor = useCallback((t: number) => {
    const n = Date.now();
    const c = Math.min(Math.max(t, n), n + 7 * 24 * 3600_000);
    setCursor(c);
    setWs((w) => (c >= w + SPAN ? floor30(c) : c < w ? Math.max(floor30(n), floor30(c)) : w));
  }, []);

  useEffect(() => {
    if (rows.length) virt.scrollToIndex(Math.min(row, rows.length - 1), { align: 'auto' });
  }, [row]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (rows.length) virt.scrollToIndex(Math.min(row, rows.length - 1), { align: 'center' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activate = useCallback((c: Channel | undefined, p: Program | undefined) => {
    if (!c) return;
    const t = Date.now();
    if (!p || (p.start <= t && p.end > t)) {
      onTune(c.id);
      onClose();
    } else setDetail(p);
  }, [onTune, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('[role=dialog], .scrim')) return; // details / search own the keys
      const t = e.target as HTMLElement;
      if (t?.closest?.('input, select, textarea, [contenteditable]')) return;
      const handled = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      switch (e.key) {
        case 'ArrowDown': handled(); setRow((r) => Math.min(rows.length - 1, r + 1)); break;
        case 'ArrowUp': handled(); setRow((r) => Math.max(0, r - 1)); break;
        case 'PageDown': handled(); setRow((r) => Math.min(rows.length - 1, r + 8)); break;
        case 'PageUp': handled(); setRow((r) => Math.max(0, r - 8)); break;
        case 'Home': handled(); moveCursor(Date.now()); break;
        case 'ArrowRight': {
          handled();
          moveCursor(sel ? sel.end : floor30(cursor) + HALF);
          break;
        }
        case 'ArrowLeft': {
          handled();
          const from = sel ? sel.start : cursor;
          if (from <= Date.now()) { moveCursor(Date.now()); break; }
          const prev = ch ? progsAround(ch.id, from - 1).find((p) => p.start <= from - 1 && p.end > from - 1) : undefined;
          moveCursor(prev ? prev.start : from - HALF);
          break;
        }
        case 'Enter': handled(); activate(ch, sel); break;
        case 'Escape': handled(); onClose(); break;
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [rows.length, sel, cursor, ch, moveCursor, progsAround, activate, onClose]);

  const slots = [ws, ws + HALF, ws + 2 * HALF, ws + 3 * HALF];
  const nowPct = ((now - ws) / SPAN) * 100;
  const selLive = sel && sel.start <= now && sel.end > now;

  return (
    <div className="tvGuide" role="region" aria-label="Guide overlay">
      <div className="tvGuideTop">
        <div className="tvGuideInfo">
          {ch && (
            <div className="tvGuideInfoCh"><TvMark channel={ch} size={32} /><b>{ch.number}</b><span>{ch.name}</span></div>
          )}
          <h2>{sel ? sel.title : 'No information'}</h2>
          {sel && (
            <p className="tvGuideWhen">
              {fmtDay(sel.start)} · {fmtTime(sel.start)} – {fmtTime(sel.end)}
              {selLive ? ` · ${leftLabel(sel, now)}` : ''}
              {sel.subtitle ? ` · ${sel.subtitle}` : ''}
              {sel.category ? ` · ${sel.category}` : ''}
            </p>
          )}
          {sel?.description && <p className="tvGuideDesc">{sel.description}</p>}
          <p className="tvGuideKeys"><kbd>↑↓←→</kbd> move · <kbd>Enter</kbd> {selLive || !sel ? 'tune' : 'details'} · <kbd>Esc</kbd>/<kbd>G</kbd> close</p>
        </div>
        <button className="icon tvGuideClose" onClick={onClose} aria-label="Close guide"><X /></button>
      </div>
      <div className="tvGuideGrid">
        <div className="tvGuideHead">
          <div className="tvGuideCorner">{fmtDay(ws)}</div>
          <div className="tvGuideTrack">
            {slots.map((t, i) => <span key={t} style={{ left: `${i * 25}%` }}>{fmtTime(t)}</span>)}
          </div>
        </div>
        <div className="tvGuideRows" ref={scrollRef}>
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vr) => {
              const c = rows[vr.index];
              const ps = progsOf(c.id);
              const isRow = vr.index === row;
              return (
                <div key={c.id} className={`tvGuideRow ${isRow ? 'on' : ''} ${c.id === currentId ? 'tuned' : ''}`} style={{ top: vr.start, height: ROW_H }}>
                  <button className="tvGuideCh" onClick={() => { onTune(c.id); onClose(); }} title={`Tune ${c.name}`}>
                    <b>{c.number}</b><TvMark channel={c} size={30} /><span>{c.name}</span>
                  </button>
                  <div className="tvGuideTrack">
                    {nowPct > 0 && nowPct < 100 && <i className="tvGuideNow" style={{ left: `${nowPct}%` }} />}
                    {ps.length ? ps.map((p) => {
                      const l = Math.max(0, (p.start - ws) / SPAN) * 100;
                      const r = Math.min(1, (p.end - ws) / SPAN) * 100;
                      const hi = isRow && sel?.id === p.id;
                      return (
                        <button
                          key={p.id}
                          className={`tvGuideProg ${hi ? 'hi' : ''} ${p.start <= now && p.end > now ? 'live' : ''}`}
                          style={{ left: `${l}%`, width: `calc(${r - l}% - 3px)` }}
                          onClick={() => { setRow(vr.index); moveCursor(Math.max(p.start, Date.now())); activate(c, p); }}
                          title={`${p.title} · ${fmtTime(p.start)}–${fmtTime(p.end)}`}
                        >
                          <b>{p.start < ws ? '‹ ' : ''}{p.title}</b>
                          <span>{fmtTime(p.start)}</span>
                        </button>
                      );
                    }) : (
                      <button className={`tvGuideProg empty ${isRow ? 'hi' : ''}`} style={{ left: 0, width: 'calc(100% - 3px)' }} onClick={() => { onTune(c.id); onClose(); }}>
                        <b>No information</b>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {detail && <ProgramDetails p={detail} channel={rows.find((c) => c.id === detail.channelId)} onTune={(id) => { setDetail(null); onTune(id); onClose(); }} onClose={() => setDetail(null)} />}
    </div>
  );
}

function ProgramDetails({ p, channel, onTune, onClose }: { p: Program; channel?: Channel; onTune: (id: string) => void; onClose: () => void }) {
  const entryId = `prog:${p.id}`;
  const entry = useApp((s) => s.schedule.find((e) => e.id === entryId));
  const update = useApp((s) => s.update);
  const add = (reminderMin?: number) => update((st) => ({ schedule: [...st.schedule.filter((e) => e.id !== entryId), entryFromProgram(p, undefined, reminderMin)] }));
  const remove = () => update((st) => ({ schedule: st.schedule.filter((e) => e.id !== entryId) }));
  return (
    <Modal title={p.title} onClose={onClose}>
      <div className="pd">
        {p.subtitle && <h4>{p.subtitle}</h4>}
        <p className="muted">{fmtDay(p.start)} · {fmtTime(p.start)} – {fmtTime(p.end)} · {Math.round((p.end - p.start) / MIN)} min</p>
        <p className="muted">{channel ? `${channel.number} · ${channel.name}` : ''}{p.category ? ` · ${p.category}` : ''}</p>
        {p.description && <p>{p.description}</p>}
        <div className="col">
          {entry?.reminderMin != null
            ? <button onClick={remove}><BellRing /> Reminder set · remove</button>
            : <button className="primary" autoFocus onClick={() => add(5)}><Bell /> Remind me (5 min before)</button>}
          {entry ? <button onClick={remove}><Check /> In your schedule</button> : <button onClick={() => add(undefined)}><CalendarPlus /> Add to schedule</button>}
          {channel && <button onClick={() => onTune(channel.id)}><Play /> Tune to {channel.name} now</button>}
        </div>
      </div>
    </Modal>
  );
}
