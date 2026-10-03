import { useMemo, useState } from 'react';
import { Flame, Maximize2, Volume2, X } from 'lucide-react';
import Player from '../player/Player';
import { orderedChannels, useApp } from '../store/app';
import { ScoreBug } from '../components/GameCard';
import { matchBroadcasts } from '../lib/channelMatch';
import { useRankedGames } from '../hooks/useSports';
import { navigate } from '../app/router';

/** 2×2 multiview. Audio follows the focused tile; browsers may struggle beyond 4 HD streams. */
export default function MultiviewPage() {
  const s = useApp();
  const [focus, setFocus] = useState(0);
  const [layout, setLayout] = useState<'2x2' | '1+3'>('2x2');
  const list = useMemo(() => orderedChannels(s), [s.channels, s.channelOrder, s.hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useRankedGames((g) => g.state === 'in');

  const setSlot = (i: number, id: string | null) => {
    const next = [...s.multiview];
    next[i] = id;
    s.set({ multiview: next });
  };

  const autoFill = () => {
    const ids: (string | null)[] = [];
    for (const r of live) {
      const m = matchBroadcasts(r.g.broadcasts, s.channels, s.networkOverrides);
      if (m && !ids.includes(m.channel.id)) ids.push(m.channel.id);
      if (ids.length === 4) break;
    }
    for (const c of list) {
      if (ids.length >= 4) break;
      if (!ids.includes(c.id)) ids.push(c.id);
    }
    while (ids.length < 4) ids.push(null);
    s.set({ multiview: ids });
    setFocus(0);
  };

  const gameOn = (chId: string) =>
    Object.values(s.games).find((g) => g.state === 'in' && matchBroadcasts(g.broadcasts, s.channels, s.networkOverrides)?.channel.id === chId);

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
        {s.multiview.map((id, i) => {
          const ch = id ? s.channels.find((c) => c.id === id) : undefined;
          const g = ch ? gameOn(ch.id) : undefined;
          return (
            <div key={i} className={`mvTile ${focus === i ? 'focus' : ''}`} onClick={() => setFocus(i)}>
              {ch ? (
                <>
                  <Player channel={ch} compact muted={focus !== i} overlay={g && <ScoreBug g={g} />} />
                  <div className="mvBar" onClick={(e) => e.stopPropagation()}>
                    {focus === i && <Volume2 className="aud" />}
                    <b>{ch.name}</b>
                    <button className="icon" title="Watch full" onClick={() => { s.tune(ch.id); navigate('watch'); }}><Maximize2 /></button>
                    <button className="icon" title="Clear" onClick={() => setSlot(i, null)}><X /></button>
                  </div>
                </>
              ) : (
                <div className="mvEmpty" onClick={(e) => e.stopPropagation()}>
                  <select className="field" value="" onChange={(e) => setSlot(i, e.target.value)}>
                    <option value="">Choose channel…</option>
                    {live.map((r) => {
                      const m = matchBroadcasts(r.g.broadcasts, s.channels, s.networkOverrides);
                      return m ? <option key={r.g.id} value={m.channel.id}>🔴 {r.g.away.abbr} @ {r.g.home.abbr} — {m.channel.name}</option> : null;
                    })}
                    {list.map((c) => <option key={c.id} value={c.id}>{c.number} · {c.name}</option>)}
                  </select>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
