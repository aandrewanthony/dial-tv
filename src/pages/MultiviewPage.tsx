import { useEffect, useMemo, useState } from 'react';
import { Flame, Maximize2, Volume2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import Player from '../player/Player';
import { orderedChannels, useApp } from '../store/app';
import type { Channel, SportEvent } from '../types';
import { ScoreBug } from '../components/GameCard';
import { ChannelPicker, type PickOption } from '../components/ChannelPicker';
import { LockedScreen, useLockedOut } from '../components/ui';
import { matchBroadcasts } from '../lib/channelMatch';
import { useRankedGames } from '../hooks/useSports';
import { navigate } from '../app/router';
import { useTv } from '../store/tv';
import { findPersonal, usePersonalChannels } from '../components/tv/personal';
import { PersonalPlayer } from '../components/tv/PersonalPlayer';

/** 2×2 multiview. Audio follows the focused tile; browsers may struggle beyond 4 HD streams. */
export default function MultiviewPage() {
  const { channels, channelOrder, hidden } = useApp(useShallow((s) => ({ channels: s.channels, channelOrder: s.channelOrder, hidden: s.hidden })));
  const overrides = useApp((s) => s.networkOverrides);
  const games = useApp((s) => s.games);
  const multiview = useApp((s) => s.multiview);
  const [focus, setFocus] = useState(0);
  const [layout, setLayout] = useState<'2x2' | '1+3'>('2x2');
  const personalChannels = usePersonalChannels();
  // Live channels (no movies/episodes) and My Channels.
  const list = useMemo(() => [...orderedChannels({ channels, channelOrder, hidden }), ...personalChannels], [channels, channelOrder, hidden, personalChannels]);
  const live = useRankedGames((g) => g.state === 'in');

  const setSlot = (i: number, id: string | null) => {
    const next = [...useApp.getState().multiview];
    next[i] = id;
    useApp.setState({ multiview: next });
  };

  // Channel number entry / last channel while on Multiview: fill the first empty tile, else the focused one.
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const mv = useApp.getState().multiview;
      const empty = mv.indexOf(null);
      const i = empty >= 0 ? empty : focus;
      setSlot(i, id);
      setFocus(i);
    };
    window.addEventListener('dial:mvtune', on);
    return () => window.removeEventListener('dial:mvtune', on);
  }, [focus]);

  // Broadcast matching once per data change (not per tile per render).
  const liveMatches = useMemo(() => {
    const out: { g: SportEvent; ch: Channel }[] = [];
    for (const r of live) {
      const m = matchBroadcasts(r.g.broadcasts, channels, overrides);
      if (m) out.push({ g: r.g, ch: m.channel });
    }
    return out;
  }, [games, channels, overrides]); // eslint-disable-line react-hooks/exhaustive-deps
  const gameByChannel = useMemo(() => {
    const m = new Map<string, SportEvent>();
    for (const x of liveMatches) if (!m.has(x.ch.id)) m.set(x.ch.id, x.g);
    return m;
  }, [liveMatches]);

  // Live-game shortcuts first, then every channel; option ids map back to channel ids.
  const { options, optToChannel } = useMemo(() => {
    const opts: PickOption[] = [];
    const map = new Map<string, string>();
    for (const { g, ch } of liveMatches) {
      const id = `live:${g.id}`;
      opts.push({ id, label: `🔴 ${g.away.abbr} @ ${g.home.abbr} — ${ch.name}` });
      map.set(id, ch.id);
    }
    for (const c of list) {
      opts.push({ id: c.id, label: `${c.number} · ${c.name}` });
      map.set(c.id, c.id);
    }
    return { options: opts, optToChannel: map };
  }, [liveMatches, list]);

  const autoFill = () => {
    const ids: (string | null)[] = [];
    for (const { ch } of liveMatches) {
      if (!ids.includes(ch.id)) ids.push(ch.id);
      if (ids.length === 4) break;
    }
    for (const c of list) {
      if (ids.length >= 4) break;
      if (!ids.includes(c.id)) ids.push(c.id);
    }
    while (ids.length < 4) ids.push(null);
    useApp.setState({ multiview: ids });
    setFocus(0);
  };

  return (
    <div className="multiview">
      <div className="guideBar">
        <div className="chips">
          <button className={layout === '2x2' ? 'on' : ''} onClick={() => setLayout('2x2')}>2×2</button>
          <button className={layout === '1+3' ? 'on' : ''} onClick={() => setLayout('1+3')}>1 + 3</button>
        </div>
        <div className="chips">
          <button onClick={autoFill}><Flame /> Fill with best live games</button>
          <span className="muted small">Click a tile to give it audio · double-click to go full screen</span>
        </div>
      </div>
      <div className={`mvGrid l${layout.replace('+', 'p')}`}>
        {multiview.map((id, i) => {
          const ch = id ? list.find((c) => c.id === id) ?? channels.find((c) => c.id === id) : undefined;
          return (
            <div key={i} className={`mvTile ${focus === i ? 'focus' : ''}`} onClick={() => setFocus(i)}>
              {ch ? (
                <MvTile ch={ch} g={gameByChannel.get(ch.id)} focused={focus === i} onClear={() => setSlot(i, null)} />
              ) : (
                <div className="mvEmpty" onClick={(e) => e.stopPropagation()}>
                  <ChannelPicker options={options} placeholder="Choose channel…" onChange={(o) => o && setSlot(i, optToChannel.get(o) ?? o)} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MvTile({ ch, g, focused, onClear }: { ch: Channel; g?: SportEvent; focused: boolean; onClear: () => void }) {
  const lockedOut = useLockedOut(ch.id);
  const personal = useTv((s) => findPersonal(s.personal, ch.id));
  return (
    <>
      {lockedOut ? <LockedScreen /> : personal ? <PersonalPlayer def={personal} compact muted={!focused} /> : <Player channel={ch} compact muted={!focused} overlay={g && <ScoreBug g={g} />} />}
      <div className="mvBar" onClick={(e) => e.stopPropagation()}>
        {focused && <Volume2 className="aud" />}
        <b>{ch.name}</b>
        <button className="icon" title="Watch full" onClick={() => { useApp.getState().tune(ch.id); navigate('watch'); }}><Maximize2 /></button>
        <button className="icon" title="Clear" onClick={onClear}><X /></button>
      </div>
    </>
  );
}
