import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { Toggle } from '../ui';
import { useApp } from '../../store/app';
import { setChannelPrefs, setKeepDead, useChannelPrefs } from '../../store/channelPrefs';
import { requestRecheck, resetStreamHealth, useStreamHealth } from '../../store/streamHealth';
import { DAILY_CAP, isPlaybackBusy } from '../../lib/deadChecker';
import { isChannelDead, urlKey, channelUrls } from '../../lib/streamHealth';
import { isDesktop } from '../../lib/net';
import type { OrgChannel } from '../../lib/channelOrg';

const ago = (t?: number) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 60 ? `${Math.max(1, m)} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** Is this channel hidden as dead right now (feature on, all links dead, not kept)? */
export function useIsDead(c: OrgChannel | undefined): boolean {
  const on = useChannelPrefs((s) => s.hideDead);
  const kept = useChannelPrefs((s) => !!c && s.keepDead.includes(c.id));
  const urls = useStreamHealth((s) => s.urls);
  return !!c && on && !kept && isChannelDead(c, urls);
}

/** Why a dead channel counts as dead: "HTTP 404 · checked 3 h ago". */
export function deadReason(c: OrgChannel): string {
  const urls = useStreamHealth.getState().urls;
  const hs = channelUrls(c).map((u) => urls[urlKey(u)]).filter(Boolean);
  const last = hs.reduce((a, h) => ((h!.lastFail ?? 0) > (a?.lastFail ?? 0) ? h : a), hs[0]);
  return last ? [last.why, last.lastFail && `checked ${ago(last.lastFail)}`].filter(Boolean).join(' · ') : '';
}

/** Menu items for a channel row: re-check / keep anyway (dead), or stop keeping (kept). */
export function DeadMenuItems({ c, onClose }: { c: OrgChannel; onClose: () => void }) {
  const dead = useIsDead(c);
  const on = useChannelPrefs((s) => s.hideDead);
  const kept = useChannelPrefs((s) => s.keepDead.includes(c.id));
  if (!on || (!dead && !kept)) return null;
  return (
    <>
      <div className="chMenuSep">{dead ? `Dead · ${deadReason(c)}` : 'Kept anyway'}</div>
      {dead && (
        <button role="menuitem" onClick={() => { recheck([c.id]); onClose(); }}><RefreshCw /> Re-check now</button>
      )}
      {dead ? (
        <button role="menuitem" onClick={() => { setKeepDead(c.id, true); onClose(); }}><ShieldCheck /> Keep anyway</button>
      ) : (
        <button role="menuitem" onClick={() => { setKeepDead(c.id, false); onClose(); }}><ShieldOff /> Hide again if dead</button>
      )}
    </>
  );
}

function recheck(ids: string[]) {
  requestRecheck(ids);
  useApp.getState().toast({
    kind: 'info',
    title: ids.length === 1 ? 'Re-check queued' : `${ids.length} channels queued for a re-check`,
    body: isPlaybackBusy() ? 'Checks run one at a time once nothing is playing or recording (leave Live TV or stop the player).' : 'Checks run one at a time, about one every 15 seconds.',
    ttl: 6000,
  });
}

/** Bar above the "Dead channels" list on Live TV. */
export function DeadBar({ dead }: { dead: OrgChannel[] }) {
  const queued = useStreamHealth((s) => s.recheck.length);
  return (
    <div className="deadBar">
      <p className="muted small">
        These channels failed two checks at least 6 hours apart, so they're hidden from the lineup and guide.
        They come back on their own when a later check (or playing one) works. Use a channel's ⋯ menu to keep it anyway.
        {queued > 0 && ` ${queued} queued for a re-check.`}
      </p>
      {dead.length > 0 && <button className="ghost" onClick={() => recheck(dead.map((c) => c.id))}><RefreshCw /> Re-check all</button>}
    </div>
  );
}

/** Settings → Channels → Organize: the "Hide dead channels" switch and the checker's status. */
export function HideDeadSetting({ deadCount }: { deadCount: number }) {
  const on = useChannelPrefs((s) => s.hideDead);
  const kept = useChannelPrefs((s) => s.keepDead.length);
  const { day, dayCount, recheck: queued } = useStreamHealth(useShallow((s) => ({ day: s.day, dayCount: s.dayCount, recheck: s.recheck.length })));
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, [on]);
  const d = new Date();
  const checkedToday = day === `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` ? dayCount : 0;
  return (
    <>
      <div className="setting">
        <div>
          <b>Hide dead channels</b>
          <span>
            Slowly checks your channels’ links in the background: one at a time, at most one every 15 seconds and {DAILY_CAP} a day,
            never while something is playing or recording. A channel that fails twice, at least 6 hours apart, leaves the lineup and guide
            (merged channels only when every source fails) and is listed under “Dead channels” on Live TV. It comes back when it works again.
            {!isDesktop() && ' In a browser only providers that allow web access can be checked; the desktop app checks them all.'}
          </span>
          {on && (
            <span>
              Checked today: {checkedToday} of {DAILY_CAP} · Dead: {deadCount}{kept ? ` · Kept anyway: ${kept}` : ''}{queued ? ` · ${queued} queued` : ''}
              {isPlaybackBusy() ? ' · Paused while something plays' : ''}
            </span>
          )}
        </div>
        <Toggle label="Hide dead channels" on={on} onChange={(v) => setChannelPrefs({ hideDead: v })} />
      </div>
      {on && (
        <div className="row deadActions">
          {kept > 0 && <button className="ghost" onClick={() => setChannelPrefs({ keepDead: [] })}>Stop keeping {kept} channel{kept === 1 ? '' : 's'}</button>}
          <button className="ghost" onClick={() => resetStreamHealth()} title="Forget every check result and start over">Forget check results</button>
        </div>
      )}
    </>
  );
}
