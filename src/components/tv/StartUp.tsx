import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useApp, type Settings } from '../../store/app';
import { setChannelPrefs } from '../../store/channelPrefs';
import { SPORTS, type SportKey } from '../../lib/sportsOf';
import { ChannelPicker } from '../ChannelPicker';
import type { SportBucket } from '../channels/useSportRail';
import type { Channel } from '../../types';

export type StartMode = Settings['startup'];

const setStart = (p: Partial<Pick<Settings, 'startup' | 'startChannel' | 'startSport' | 'startupAsked'>>) =>
  useApp.getState().update((st) => ({ settings: { ...st.settings, startupAsked: true, ...p } }));

let applied = false;

/**
 * Applies the start-up choice once per app run when Live TV first has channels: tune the chosen
 * channel, or open the chosen sport and tune what's live in it (else its first channel).
 */
export function useStartUp(list: Channel[], sports: Map<SportKey, SportBucket>) {
  const mode = useApp((s) => s.settings.startup);
  const startChannel = useApp((s) => s.settings.startChannel);
  const startSport = useApp((s) => s.settings.startSport);
  useEffect(() => {
    if (applied || !list.length) return;
    applied = true;
    const tune = useApp.getState().tune;
    if (mode === 'channel' && startChannel && list.some((c) => c.id === startChannel)) tune(startChannel);
    else if (mode === 'sport' && startSport) {
      setChannelPrefs({ railGroup: `sport:${startSport}` });
      const b = sports.get(startSport as SportKey);
      const id = (b && ([...b.live][0] ?? b.ids[0])) as string | undefined;
      if (id) tune(id);
    }
  }, [list, sports, mode, startChannel, startSport]);
}

/** Settings → Playback: what Dial TV opens on. */
export function StartUpSetting({ channels }: { channels: Channel[] }) {
  const s = useApp((st) => st.settings);
  const options = useMemo(() => channels.slice(0, 5000).map((c) => ({ id: c.id, label: `${c.number} · ${(c as { displayName?: string }).displayName ?? c.name}` })), [channels]);
  return (
    <div className="setting startSetting">
      <div><b>Start Dial TV on</b><span>What plays when the app opens.</span></div>
      <div className="col">
        <div className="chips">
          {([['last', 'Last channel'], ['channel', 'A channel'], ['sport', 'A sport']] as [StartMode, string][]).map(([m, l]) => (
            <button key={m} className={s.startup === m ? 'on' : ''} aria-pressed={s.startup === m} onClick={() => setStart({ startup: m })}>{l}</button>
          ))}
        </div>
        {s.startup === 'channel' && <ChannelPicker value={s.startChannel} options={options} placeholder="Choose channel…" onChange={(id) => setStart({ startChannel: id })} />}
        {s.startup === 'sport' && (
          <div className="chips">{SPORTS.filter((x) => x.key !== 'networks').map((x) => (
            <button key={x.key} className={s.startSport === x.key ? 'on' : ''} aria-pressed={s.startSport === x.key} onClick={() => setStart({ startSport: x.key })}>{x.icon} {x.label}</button>
          ))}</div>
        )}
      </div>
    </div>
  );
}

/** One-time question on Live TV (until answered or closed). */
export function StartUpAsk({ current, sportsWithChannels }: { current?: Channel; sportsWithChannels: SportKey[] }) {
  const asked = useApp((s) => s.settings.startupAsked);
  if (asked || !current || !sportsWithChannels.length) return null;
  const name = (current as { displayName?: string }).displayName ?? current.name;
  return (
    <div className="startAsk" role="region" aria-label="Start up">
      <b>When Dial TV opens, start on…</b>
      <div className="chips">
        <button onClick={() => setStart({ startup: 'last' })}>Last channel</button>
        <button onClick={() => setStart({ startup: 'channel', startChannel: current.id })}>{name}</button>
        {SPORTS.filter((x) => sportsWithChannels.includes(x.key) && x.key !== 'networks').slice(0, 6).map((x) => (
          <button key={x.key} onClick={() => setStart({ startup: 'sport', startSport: x.key })}>{x.icon} {x.label}</button>
        ))}
      </div>
      <button className="icon" onClick={() => setStart({})} aria-label="Not now"><X /></button>
    </div>
  );
}
