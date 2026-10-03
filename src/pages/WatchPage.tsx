import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Heart, History, Lock, Pin, PinOff, Play } from 'lucide-react';
import { desktop } from '../lib/net';
import Player, { type PlayerHandle } from '../player/Player';
import { nowPlaying, orderedChannels, useApp } from '../store/app';
import { ChannelMark, fmtTime } from '../components/ui';
import { AddPlaylist } from '../components/AddPlaylist';
import { ScoreBug } from '../components/GameCard';
import { matchBroadcasts } from '../lib/channelMatch';

export default function WatchPage() {
  const s = useApp();
  const player = useRef<PlayerHandle>(null);
  const [group, setGroup] = useState<string>('All');
  const [filter, setFilter] = useState('');
  const [pinned, setPinned] = useState(false);
  // Big public playlists have 10k+ channels: render in pages to keep the page fast.
  const [limit, setLimit] = useState(240);
  useEffect(() => setLimit(240), [group, filter]);
  /** Desktop mini player: shrink to a small always-on-top window in theater mode. */
  const togglePin = async () => {
    const next = !pinned;
    await desktop()?.setMiniPlayer(next);
    useApp.setState({ theater: next });
    setPinned(next);
  };
  const list = useMemo(() => orderedChannels(s), [s.channels, s.channelOrder, s.hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = s.channels.find((c) => c.id === s.currentId) ?? list[0];

  // Player keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
      const p = player.current;
      if (!p) return;
      switch (e.key) {
        case ' ':
        case 'k': e.preventDefault(); p.togglePlay(); break;
        case 'm': p.toggleMute(); break;
        case 'f': p.fullscreen(); break;
        case 'p': void p.pip(); break;
        case 'i': p.toggleStats(); break;
        case 't': useApp.setState((st) => ({ theater: !st.theater })); break;
        case '[': p.volume(-0.1); break;
        case ']': p.volume(0.1); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Live game on the tuned channel → score bug
  const liveGame = useMemo(() => {
    if (!current) return undefined;
    return Object.values(s.games).find((g) => g.state === 'in' && matchBroadcasts(g.broadcasts, s.channels, s.networkOverrides)?.channel.id === current.id);
  }, [s.games, s.channels, s.networkOverrides, current]);

  if (!current) {
    return (
      <div className="panel welcome">
        <h2>Add your channels</h2>
        <p className="muted">Paste your M3U playlist link or choose an .m3u file. Dial TV doesn't come with channels. It plays yours and adds the sports layer on top.</p>
        {s.loadingSources ? <p className="muted">Loading playlist…</p> : <AddPlaylist />}
        {s.playlists.some((p) => p.error) && <p className="err">{s.playlists.find((p) => p.error)?.error}</p>}
      </div>
    );
  }

  const now = nowPlaying(s.programs, current.id);
  const next = s.programs.filter((p) => p.channelId === current.id && p.start >= (now?.end ?? Date.now())).sort((a, b) => a.start - b.start)[0];
  const fav = s.favorites.includes(current.id);
  const groups = ['All', 'Favorites', ...Array.from(new Set(list.map((c) => c.group)))];
  const shown = list.filter((c) =>
    (group === 'All' || (group === 'Favorites' ? s.favorites.includes(c.id) : c.group === group)) &&
    (!filter || c.name.toLowerCase().includes(filter.toLowerCase()) || String(c.number).startsWith(filter)),
  );
  const idx = list.findIndex((c) => c.id === current.id);
  const step = (d: number) => s.tune(list[(idx + d + list.length) % list.length].id);
  const prev = s.channels.find((c) => c.id === s.prevChannelId);
  const progress = now ? Math.min(100, ((Date.now() - now.start) / (now.end - now.start)) * 100) : 0;

  return (
    <div className="watch">
      {pinned && <button className="miniExit" onClick={() => void togglePin()} title="Exit mini player"><PinOff /> Exit mini player</button>}
      <section className="hero">
        <div className="screen">
          <Player
            ref={player}
            channel={current}
            theater={s.theater}
            onTheater={() => s.set({ theater: !s.theater })}
            overlay={liveGame && <ScoreBug g={liveGame} />}
          />
        </div>
        <div className="now">
          <div className="nowTop">
            <span className="live">● LIVE</span>
            <div className="zap">
              <button className="icon" onClick={() => step(-1)} title="Channel up (↑)"><ChevronUp /></button>
              <button className="icon" onClick={() => step(1)} title="Channel down (↓)"><ChevronDown /></button>
            </div>
          </div>
          <small>CH {current.number} · {current.group}</small>
          <h2>{current.name}</h2>
          {now ? (
            <div className="np">
              <b>{now.title}</b>{now.subtitle && <span>{now.subtitle}</span>}
              <div className="bar"><i style={{ width: `${progress}%` }} /></div>
              <small>{fmtTime(now.start)} – {fmtTime(now.end)}</small>
              {now.description && <p>{now.description}</p>}
            </div>
          ) : <p className="muted">No guide data for this channel.</p>}
          {next && <p className="nextLine"><small>NEXT</small> {fmtTime(next.start)} · {next.title}</p>}
          <div className="row">
            <button onClick={() => s.update((st) => ({ favorites: fav ? st.favorites.filter((x) => x !== current.id) : [...st.favorites, current.id] }))}>
              <Heart fill={fav ? 'currentColor' : 'none'} /> {fav ? 'Favorited' : 'Favorite'}
            </button>
            {prev && <button onClick={() => s.tune(prev.id)} title="Last channel (L)"><History /> {prev.name}</button>}
            {desktop() && <button onClick={() => void togglePin()} title="Mini player: small, always on top">{pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin' : 'Mini player'}</button>}
          </div>
        </div>
      </section>

      <div className="chanBar">
        <div className="chips">
          {groups.map((g) => <button key={g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>{g}</button>)}
        </div>
        <input className="field small" placeholder="Filter or channel #" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="channels">
        {shown.slice(0, limit).map((c) => {
          const np = nowPlaying(s.programs, c.id);
          return (
            <button key={c.id} className={current.id === c.id ? 'selected' : ''} onClick={() => s.tune(c.id)}>
              <ChannelMark channel={c} />
              <div>
                <small>{c.number} · {c.group}</small>
                <b>{c.name}</b>
                {np && <span className="np1">{np.title}</span>}
              </div>
              {s.settings.locked.includes(c.id) ? <Lock /> : s.favorites.includes(c.id) ? <Heart fill="currentColor" /> : <Play />}
            </button>
          );
        })}
        {!shown.length && <p className="muted">No channels match.</p>}
        {shown.length > limit && <button className="moreBtn" onClick={() => setLimit((l) => l + 480)}>Show more · {shown.length - limit} more channels (or type to filter)</button>}
      </div>
    </div>
  );
}
