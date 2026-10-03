import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronUp, Heart, History, Info, ListVideo, Lock, Pin, PinOff, Play } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { desktop } from '../lib/net';
import Player, { type PlayerHandle } from '../player/Player';
import { orderedChannels, useApp } from '../store/app';
import { isPersonalId, useTv } from '../store/tv';
import { LockedScreen, fmtTime, useLockedOut, useNow } from '../components/ui';
import { AddPlaylist } from '../components/AddPlaylist';
import { ScoreBug } from '../components/GameCard';
import { matchBroadcasts } from '../lib/channelMatch';
import { findPersonal, nowNext, TvMark, usePersonalChannels } from '../components/tv/personal';
import { PersonalPlayer } from '../components/tv/PersonalPlayer';
import { GuideOverlay } from '../components/tv/GuideOverlay';
import { InfoBanner } from '../components/tv/InfoBanner';
import { navigate } from '../app/router';

/** Keys on these targets belong to the element (Space activates buttons/switches). */
const OWN_SPACE = 'button, [role=switch], a, input, select, textarea, [contenteditable]';
const OWN_KEYS = 'input, select, textarea, [contenteditable]';
const BANNER_MS = 4000;

/**
 * Live TV. Keys (on this page): G guide overlay · B or Enter channel banner · ↑/↓ channel
 * up/down (includes My Channels) · digits tune by number · plus the player keys.
 */
export default function WatchPage() {
  const { channels, channelOrder, hidden } = useApp(useShallow((s) => ({ channels: s.channels, channelOrder: s.channelOrder, hidden: s.hidden })));
  const currentId = useApp((s) => s.currentId);
  const lastChannelId = useApp((s) => s.lastChannelId);
  const prevChannelId = useApp((s) => s.prevChannelId);
  const programs = useApp((s) => s.programs);
  const games = useApp((s) => s.games);
  const overrides = useApp((s) => s.networkOverrides);
  const favorites = useApp((s) => s.favorites);
  const locked = useApp((s) => s.settings.locked);
  const theater = useApp((s) => s.theater);
  const loadingSources = useApp((s) => s.loadingSources);
  const playlistError = useApp((s) => s.playlists.find((p) => p.error)?.error);
  const { tune, update } = useApp(useShallow((s) => ({ tune: s.tune, update: s.update })));
  const personalDefs = useTv((s) => s.personal);
  const durations = useTv((s) => s.durations);
  const tvHydrated = useTv((s) => s.hydrated);
  const personalChannels = usePersonalChannels();
  const player = useRef<PlayerHandle>(null);
  const [group, setGroup] = useState<string>('All');
  const [filter, setFilter] = useState('');
  const [pinned, setPinned] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [bannerAt, setBannerAt] = useState(0);
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  const now = useNow(30_000);
  // Re-render while the banner shows so its clock/progress is current and it hides on time.
  const [, setBannerTick] = useState(0);
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
  // Leaving Watch while pinned: restore the normal window and layout.
  useEffect(() => () => {
    if (!pinnedRef.current) return;
    void desktop()?.setMiniPlayer(false);
    useApp.setState({ theater: false });
  }, []);

  /** Live channels, then My Channels (personal scheduled channels). */
  const live = useMemo(() => orderedChannels({ channels, channelOrder, hidden }), [channels, channelOrder, hidden]);
  const list = useMemo(() => [...live, ...personalChannels], [live, personalChannels]);
  const listRef = useRef(list);
  listRef.current = list;

  // Reloading playlists resets the tuned channel to a playlist channel; restore a tuned personal channel.
  useEffect(() => {
    if (!tvHydrated || !isPersonalId(lastChannelId) || currentId === lastChannelId) return;
    if (findPersonal(personalDefs, lastChannelId)) useApp.setState({ currentId: lastChannelId });
  }, [tvHydrated, currentId, lastChannelId, personalDefs]);

  const current = useMemo(() => list.find((c) => c.id === currentId), [list, currentId]) ?? list[0];
  const personal = findPersonal(personalDefs, current?.id);
  const lockedOut = useLockedOut(current?.id);
  const ctx = useMemo(() => ({ programs, personal: personalDefs, durations }), [programs, personalDefs, durations]);

  // Banner on every channel change.
  useEffect(() => { if (current) setBannerAt(Date.now()); }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const bannerOn = bannerAt > 0 && Date.now() - bannerAt < BANNER_MS && !guideOpen;
  useEffect(() => {
    if (!bannerAt) return;
    const t = setTimeout(() => setBannerTick((x) => x + 1), BANNER_MS + 50);
    return () => clearTimeout(t);
  }, [bannerAt]);

  // Player keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.(OWN_KEYS) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ' && t?.closest?.(OWN_SPACE)) return;
      // Dialogs, drawers and the search palette own the keyboard while open.
      if (document.querySelector('.scrim, [role=dialog]')) return;
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

  // Cable keys. Capture phase so they run before the app-wide keys (where G opens the Guide page,
  // ↑/↓ and digits only know playlist channels).
  const guideOpenRef = useRef(guideOpen);
  guideOpenRef.current = guideOpen;
  useEffect(() => {
    let digits = '';
    let digitTimer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.(OWN_KEYS) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (useApp.getState().searchOpen || document.querySelector('.scrim, [role=dialog]')) return;
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      const all = listRef.current;
      if (e.key === 'g' || e.key === 'G') { stop(); setGuideOpen((o) => !o); return; }
      if (guideOpenRef.current) return; // the overlay handles its own keys
      const st = useApp.getState();
      const zap = (d: number) => {
        if (!all.length) return;
        const idx = all.findIndex((c) => c.id === st.currentId);
        st.tune(all[(idx + d + all.length) % all.length].id);
      };
      if (/^[0-9]$/.test(e.key)) {
        stop();
        digits += e.key;
        clearTimeout(digitTimer);
        useApp.setState((s) => ({ toasts: [...s.toasts.filter((x) => x.id !== 'chnum'), { id: 'chnum', kind: 'info', title: `CH ${digits}` }] }));
        digitTimer = setTimeout(() => {
          const typed = digits;
          digits = '';
          const app = useApp.getState();
          app.dismissToast('chnum');
          const ch = listRef.current.find((c) => String(c.number) === typed);
          if (ch) app.tune(ch.id);
          else app.toast({ kind: 'error', title: `CH ${typed} not found`, ttl: 3000 });
        }, 1200);
        return;
      }
      switch (e.key) {
        case 'ArrowUp': case 'PageUp': stop(); zap(-1); break;
        case 'ArrowDown': case 'PageDown': stop(); zap(1); break;
        case 'b': case 'B': stop(); setBannerAt((a) => (Date.now() - a < BANNER_MS ? 0 : Date.now())); break;
        case 'Enter':
          if (t?.closest?.(OWN_SPACE)) return; // Enter on a focused button activates it
          stop(); setBannerAt(Date.now()); break;
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => { window.removeEventListener('keydown', onKey, { capture: true }); clearTimeout(digitTimer); };
  }, []);

  // Live game on the tuned channel → score bug
  const liveGame = useMemo(() => {
    if (!current || personal) return undefined;
    return Object.values(games).find((g) => g.state === 'in' && matchBroadcasts(g.broadcasts, channels, overrides)?.channel.id === current.id);
  }, [games, channels, overrides, current, personal]);

  const groups = useMemo(() => ['All', 'Favorites', ...Array.from(new Set(list.map((c) => c.group)))], [list]);
  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return list.filter((c) =>
      (group === 'All' || (group === 'Favorites' ? favorites.includes(c.id) : c.group === group)) &&
      (!f || c.name.toLowerCase().includes(f) || String(c.number).startsWith(filter)),
    );
  }, [list, group, filter, favorites]);

  if (!current) {
    return (
      <div className="panel welcome">
        <h2>Add your channels</h2>
        <p className="muted">Paste your M3U playlist link or choose an .m3u file. Dial TV doesn't come with channels. It plays yours and adds the sports layer on top.</p>
        {loadingSources ? <p className="muted">Loading playlist…</p> : <AddPlaylist />}
        {playlistError && <p className="err">{playlistError}</p>}
      </div>
    );
  }

  const { now: np, next } = nowNext(current.id, now, ctx);
  const fav = favorites.includes(current.id);
  const idx = list.findIndex((c) => c.id === current.id);
  const step = (d: number) => tune(list[(idx + d + list.length) % list.length].id);
  const prev = prevChannelId ? list.find((c) => c.id === prevChannelId) : undefined;
  const progress = np ? Math.min(100, ((now - np.start) / (np.end - np.start)) * 100) : 0;
  const bannerNow = Date.now();
  const bn = bannerOn ? nowNext(current.id, bannerNow, ctx) : undefined;
  const overlay = (
    <>
      {liveGame && <ScoreBug g={liveGame} />}
      {bn && <InfoBanner channel={current} now={bn.now} next={bn.next} at={bannerNow} />}
    </>
  );
  const toggleTheater = () => useApp.setState((st) => ({ theater: !st.theater }));

  return (
    <div className={`watch ${guideOpen ? 'tvGuideOpen' : ''}`}>
      {pinned && <button className="miniExit" onClick={() => void togglePin()} title="Exit mini player"><PinOff /> Exit mini player</button>}
      <section className="hero">
        <div className="screen">
          {lockedOut ? <LockedScreen /> : personal ? (
            <PersonalPlayer ref={player} def={personal} theater={theater} onTheater={toggleTheater} overlay={overlay} />
          ) : (
            <Player ref={player} channel={current} theater={theater} onTheater={toggleTheater} overlay={overlay} />
          )}
        </div>
        <div className="now">
          <div className="nowTop">
            <span className="live">{personal ? '● MY CHANNEL' : '● LIVE'}</span>
            <div className="zap">
              <button className="icon" onClick={() => step(-1)} title="Channel up (↑)"><ChevronUp /></button>
              <button className="icon" onClick={() => step(1)} title="Channel down (↓)"><ChevronDown /></button>
            </div>
          </div>
          <small>CH {current.number} · {current.group}</small>
          <h2>{current.name}</h2>
          {np ? (
            <div className="np">
              <b>{np.title}</b>{np.subtitle && <span>{np.subtitle}</span>}
              <div className="bar"><i style={{ width: `${progress}%` }} /></div>
              <small>{fmtTime(np.start)} – {fmtTime(np.end)}</small>
              {np.description && <p>{np.description}</p>}
            </div>
          ) : <p className="muted">No guide data for this channel.</p>}
          {next && <p className="nextLine"><small>NEXT</small> {fmtTime(next.start)} · {next.title}</p>}
          <div className="row">
            <button className="tvGuideBtn" onClick={() => setGuideOpen(true)} title="Guide over live TV (G)"><CalendarDays /> Guide</button>
            <button onClick={() => setBannerAt(Date.now())} title="Channel info (B or Enter)"><Info /> Info</button>
            <button onClick={() => update((st) => ({ favorites: fav ? st.favorites.filter((x) => x !== current.id) : [...st.favorites, current.id] }))}>
              <Heart fill={fav ? 'currentColor' : 'none'} /> {fav ? 'Favorited' : 'Favorite'}
            </button>
            {prev && <button onClick={() => tune(prev.id)} title="Last channel (L)"><History /> {prev.name}</button>}
            {personal && <button onClick={() => navigate('channels')}><ListVideo /> Edit channel</button>}
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
          const cp = nowNext(c.id, now, ctx).now;
          return (
            <button key={c.id} className={current.id === c.id ? 'selected' : ''} onClick={() => tune(c.id)}>
              <TvMark channel={c} />
              <div>
                <small>{c.number} · {c.group}</small>
                <b>{c.name}</b>
                {cp && <span className="np1">{cp.title}</span>}
              </div>
              {locked.includes(c.id) ? <Lock /> : favorites.includes(c.id) ? <Heart fill="currentColor" /> : <Play />}
            </button>
          );
        })}
        {!shown.length && <p className="muted">No channels match.</p>}
        {shown.length > limit && <button className="moreBtn" onClick={() => setLimit((l) => l + 480)}>Show more · {shown.length - limit} more channels (or type to filter)</button>}
      </div>
      {guideOpen && <GuideOverlay rows={list} currentId={current.id} onTune={(id) => tune(id)} onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
