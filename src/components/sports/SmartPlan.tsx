import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, EyeOff, Grid2x2, Pin, Play, Sparkles, Wand2 } from 'lucide-react';
import { useApp } from '../../store/app';
import { useSchedulePrefs } from '../../store/schedulePrefs';
import { useSmartPlan } from '../../hooks/useSports';
import { HOUR, planEntries, startOfDay, type PlanCandidate, type PlanSlot } from '../../lib/scheduler';
import { Empty, Toggle, fmtDay, fmtTime } from '../ui';
import { navigate } from '../../app/router';

const TIER_LABEL: Record<PlanCandidate['tier'], string> = { pinned: 'Pinned', team: 'My team', fantasy: 'Fantasy', bet: 'Bet', rule: 'Rule', national: 'Big game', other: 'Other' };

export type Horizon = 'tonight' | 'tomorrow' | 'week';
export function horizonRange(h: Horizon, now = Date.now()): [number, number] {
  const today = startOfDay(now);
  if (h === 'tonight') return [now, today + 28 * HOUR]; // through 4 AM
  if (h === 'tomorrow') {
    const t = startOfDay(today + 26 * HOUR);
    return [t, t + 28 * HOUR];
  }
  return [now, today + 7 * 24 * HOUR];
}

function useChannelName() {
  const channels = useApp((s) => s.channels);
  return (id?: string) => (id ? channels.find((c) => c.id === id)?.name : undefined);
}

/** Accept: put each primary pick on the schedule (with its channel) and remember it for auto-tune. */
export function acceptPlan(slots: PlanSlot[]) {
  const app = useApp.getState();
  const prefs = useSchedulePrefs.getState();
  const entries = planEntries(slots, app.games, (c) => c.channelId, prefs.reminderMin ?? undefined);
  app.update((s) => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const kept = s.schedule.map((e) => {
      const n = byId.get(e.id);
      if (!n) return e;
      byId.delete(e.id);
      return { ...e, channelId: e.channelId ?? n.channelId, reminderMin: e.reminderMin ?? n.reminderMin };
    });
    return { schedule: [...kept, ...byId.values()], dismissed: s.dismissed.filter((id) => !entries.some((e) => e.id === id)) };
  });
  useSchedulePrefs.setState({ planned: [...new Set([...prefs.planned.filter((id) => useApp.getState().schedule.some((e) => e.id === id && e.end > Date.now())), ...entries.map((e) => e.id)])] });
  return entries.length;
}

function Cand({ c, primary }: { c: PlanCandidate; primary?: boolean }) {
  const name = useChannelName()(c.channelId);
  const pinned = useSchedulePrefs((s) => s.pinned.includes(c.id));
  const tune = useApp((s) => s.tune);
  const live = c.start <= Date.now() && c.end > Date.now();
  return (
    <div className={`planCand ${primary ? 'primary' : ''} tier-${c.tier}`}>
      <span className="tierTag">{TIER_LABEL[c.tier]}</span>
      <div className="pcMain">
        <b>{c.title}</b>
        <small>{fmtTime(c.start)} · {c.reasons.join(' · ')}</small>
      </div>
      <span className={`chName ${name ? '' : 'none'}`}>{name ?? 'No channel match'}</span>
      {primary && (
        <button className="icon" aria-label={pinned ? 'Unpin' : 'Pin to top'} title={pinned ? 'Unpin' : 'Pin: always pick this'} onClick={() => useSchedulePrefs.setState((s) => ({ pinned: pinned ? s.pinned.filter((x) => x !== c.id) : [...s.pinned, c.id] }))}><Pin className={pinned ? 'on' : ''} /></button>
      )}
      {!primary && (
        <button className="icon" aria-label="Make this the pick" title="Make this the pick here" onClick={() => useSchedulePrefs.setState((s) => ({ pinned: [...s.pinned.filter((x) => x !== c.id), c.id] }))}><Pin /></button>
      )}
      <button className="icon" aria-label="Skip" title="Leave out of the plan" onClick={() => useSchedulePrefs.setState((s) => ({ skipped: [...s.skipped, c.id], pinned: s.pinned.filter((x) => x !== c.id) }))}><EyeOff /></button>
      {live && c.channelId && <button className="watchBtn" onClick={() => { tune(c.channelId!); navigate('watch'); }}><Play /> Watch</button>}
    </div>
  );
}

function SlotRow({ s }: { s: PlanSlot }) {
  const set = useApp((st) => st.set);
  const mv = [s.primary, ...s.also].map((c) => c.channelId).filter((x, i, a): x is string => !!x && a.indexOf(x) === i).slice(0, 4);
  return (
    <div className={`planSlot ${s.conflict ? 'conflict' : ''}`}>
      <time>{fmtTime(s.start)}<small>– {fmtTime(s.end)}</small></time>
      <div className="psBody">
        <Cand c={s.primary} primary />
        {s.also.length > 0 && (
          <div className="also">
            <span className="muted small"><AlertTriangle /> Also on — {s.also.length === 1 ? 'conflict' : `${s.also.length} conflicts`}:</span>
            {s.also.map((c) => <Cand key={c.id} c={c} />)}
            {mv.length > 1 && (
              <button className="ghost small" onClick={() => { set({ multiview: [...mv, null, null, null].slice(0, 4) as (string | null)[] }); navigate('multiview'); }}><Grid2x2 /> Watch {mv.length} in Multiview</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Full Smart Schedule planner (Schedule → Smart plan). */
export function SmartPlanner() {
  const [horizon, setHorizon] = useState<Horizon>('tonight');
  // Recompute the window when the horizon changes (minute resolution is enough).
  const [from, to] = useMemo(() => horizonRange(horizon), [horizon]);
  const { slots } = useSmartPlan(from, to);
  const prefs = useSchedulePrefs();
  const schedule = useApp((s) => s.schedule);
  const [msg, setMsg] = useState<string>();
  const accepted = slots.length > 0 && slots.every((s) => schedule.some((e) => e.id === s.primary.id) && prefs.planned.includes(s.primary.id));
  const conflicts = slots.filter((s) => s.conflict).length;
  let lastDay = '';

  return (
    <div className="smartPlan">
      <div className="guideBar">
        <div className="chips">
          {(['tonight', 'tomorrow', 'week'] as const).map((h) => <button key={h} className={horizon === h ? 'on' : ''} onClick={() => setHorizon(h)}>{h === 'tonight' ? 'My night' : h === 'tomorrow' ? 'Tomorrow' : 'My week'}</button>)}
        </div>
        <div className="chips">
          {prefs.skipped.length > 0 && <button onClick={() => useSchedulePrefs.setState({ skipped: [] })}>Show {prefs.skipped.length} skipped</button>}
          <button className="primary" disabled={!slots.length || accepted} onClick={() => { const n = acceptPlan(slots); setMsg(`${n} item${n === 1 ? '' : 's'} on your schedule.`); }}>
            {accepted ? <><CheckCircle2 /> Plan accepted</> : <><Wand2 /> Accept plan</>}
          </button>
        </div>
      </div>
      <div className="planOpts">
        <label className="inlineToggle">Auto-tune when a planned item starts <Toggle on={prefs.autoTune} onChange={(v) => useSchedulePrefs.setState({ autoTune: v })} label="Auto-tune" /></label>
        <label className="inlineToggle">Don’t interrupt if I’m watching another of my teams <Toggle on={prefs.dontInterruptMyTeam} onChange={(v) => useSchedulePrefs.setState({ dontInterruptMyTeam: v })} label="Don't interrupt my teams" /></label>
        <label className="inlineToggle">Include big games without a personal stake <Toggle on={prefs.includeOther} onChange={(v) => useSchedulePrefs.setState({ includeOther: v })} label="Include big games" /></label>
        <label className="inlineToggle">Reminders
          <select className="field small" value={prefs.reminderMin ?? ''} onChange={(e) => useSchedulePrefs.setState({ reminderMin: e.target.value === '' ? null : +e.target.value })}>
            <option value="">None</option>{[0, 5, 10, 15, 30].map((m) => <option key={m} value={m}>{m ? `${m} min before` : 'At start'}</option>)}
          </select>
        </label>
      </div>
      {msg && <div className="banner">{msg} {prefs.autoTune ? 'Auto-tune will switch channels as each starts.' : ''}</div>}
      {conflicts > 0 && <div className="banner warn"><AlertTriangle /> {conflicts} time slot{conflicts > 1 ? 's have' : ' has'} overlapping games — the plan picks one by priority (my team › fantasy › bets/rules › big games); the rest are Multiview suggestions.</div>}
      {!slots.length ? (
        <Empty icon={<Sparkles />} title="Nothing to plan yet">Follow teams, connect fantasy, track bets or add show rules — the planner builds your night from them.</Empty>
      ) : (
        <div className="planList">
          {slots.map((s) => {
            const d = fmtDay(s.start);
            const head = horizon === 'week' && d !== lastDay ? <h3 className="sectionTitle">{d.toUpperCase()}</h3> : null;
            lastDay = d;
            return <div key={`${s.start}-${s.primary.id}`}>{head}<SlotRow s={s} /></div>;
          })}
        </div>
      )}
      <p className="muted small">Priority: pinned › your teams › fantasy starters › show rules › open bets › national TV / close lines / clutch games. Channels come from your playlist via the Sports Mapper (Settings → mapping).{' '}
        Auto-tune works while Dial TV is open.</p>
    </div>
  );
}

/** Compact "tonight" plan for Game Day. */
export function TonightPlan() {
  const [from, to] = useMemo(() => horizonRange('tonight'), []);
  const { slots } = useSmartPlan(from, to);
  const name = useChannelName();
  if (!slots.length) return <p className="muted">Nothing planned yet — follow teams or connect fantasy and the planner fills in your night.</p>;
  return (
    <div className="tonightPlan">
      {slots.slice(0, 5).map((s) => (
        <div className="tonightRow" key={`${s.start}-${s.primary.id}`}>
          <time>{fmtTime(s.start)}</time>
          <div><b>{s.primary.title}{s.conflict && <AlertTriangle className="warnIcon" />}</b><small>{TIER_LABEL[s.primary.tier]} · {name(s.primary.channelId) ?? 'no channel'}{s.also.length ? ` · +${s.also.length} in Multiview` : ''}</small></div>
        </div>
      ))}
    </div>
  );
}
