import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Lock, X } from 'lucide-react';
import type { Channel, Program, Team } from '../types';
import { lockedSet, programsByChannel, sha256, useApp } from '../store/app';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalHead"><h3>{title}</h3><button className="icon" onClick={onClose} aria-label="Close"><X /></button></div>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim drawerScrim" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalHead"><h3>{title}</h3><button className="icon" onClick={onClose} aria-label="Close"><X /></button></div>
        {children}
      </aside>
    </div>
  );
}

export function TeamLogo({ team, size = 28 }: { team: Team; size?: number }) {
  return team.logo ? (
    <img className="teamLogo" src={team.logo} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <span className="teamLogo mark" style={{ width: size, height: size, background: team.color }}>{team.abbr}</span>
  );
}

export function ChannelMark({ channel, size = 40 }: { channel: Channel; size?: number }) {
  return channel.logo ? (
    <span className="chMark" style={{ width: size, height: size }}><img src={channel.logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /></span>
  ) : (
    <span className="chMark" style={{ width: size, height: size }}>{channel.mark}</span>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}><span /></button>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty">{icon}<b>{title}</b>{children && <p>{children}</p>}</div>;
}

export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const fmtDay = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const tmr = new Date(Date.now() + 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tmr.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
export function countdown(ms: number) {
  const s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

// ---------- guide lookups (programs can number in the millions) ----------

/**
 * Programs grouped by playlist channel id and sorted by start; built once per programs array.
 * Same index as store/app#programsByChannel, so guide listings shared by several playlist
 * channels (one guide channel) are found under each of their ids.
 */
export function programIndex(programs: Program[]) {
  return programsByChannel(programs);
}

/** Index of the first program starting after `at` (binary search). */
function upper(list: Program[], at: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function programAt(list: Program[] | undefined, at = Date.now()) {
  if (!list?.length) return undefined;
  const p = list[upper(list, at) - 1];
  return p && p.end > at ? p : undefined;
}

export function programAfter(list: Program[] | undefined, at = Date.now()) {
  if (!list?.length) return undefined;
  for (let i = Math.max(0, upper(list, at) - 1); i < list.length; i++) if (list[i].start >= at) return list[i];
  return undefined;
}

/** Re-render every `ms` and return the current time. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---------- parental lock ----------

/** True when the channel is locked, a PIN is set and this session isn't unlocked. */
export function useLockedOut(channelId?: string) {
  return useApp((s) => !!channelId && !!s.settings.lockPin && !s.unlocked && lockedSet(s).has(channelId));
}

export function LockedScreen() {
  return <div className="lockedScreen"><Lock /><span>Locked channel</span></div>;
}

export function PinPrompt({ title = 'Enter PIN', onOk, onClose }: { title?: string; onOk: () => void; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [bad, setBad] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <form className="pinForm" onSubmit={async (e) => {
        e.preventDefault();
        if ((await sha256(pin)) === useApp.getState().settings.lockPin) onOk();
        else { setBad(true); setPin(''); }
      }}>
        <Lock />
        <p>Enter the parental PIN to continue.</p>
        <input autoFocus type="password" inputMode="numeric" value={pin} onChange={(e) => { setPin(e.target.value); setBad(false); }} aria-label="PIN" />
        {bad && <small className="err">Wrong PIN</small>}
        <div className="row"><button type="button" className="ghost" onClick={onClose}>Cancel</button><button className="primary">OK</button></div>
      </form>
    </Modal>
  );
}

/**
 * Run an action only after the parental PIN is entered (when one is set).
 * `always` asks even if this session was already unlocked.
 */
export function usePinGuard(always = false) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const guard = useCallback((fn: () => void) => {
    const s = useApp.getState();
    if (!s.settings.lockPin || (!always && s.unlocked)) fn();
    else setPending(() => fn);
  }, [always]);
  const modal = pending && (
    <PinPrompt
      onOk={() => { setPending(null); useApp.setState({ unlocked: true }); pending(); }}
      onClose={() => setPending(null)}
    />
  );
  return [guard, modal] as const;
}
