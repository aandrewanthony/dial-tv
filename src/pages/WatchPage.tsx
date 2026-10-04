import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronUp, Clock, Heart, History, Info, LayoutList, ListVideo, Pin, PinOff, Search, SlidersHorizontal, Tv } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { desktop } from '../lib/net';
import Player, { type PlayerHandle } from '../player/Player';
import { useApp } from '../store/app';
import { isPersonalId, useTv } from '../store/tv';
import { pushRecent, setChannelPrefs, useChannelPrefs } from '../store/channelPrefs';
import { LockedScreen, fmtTime, useLockedOut, useNow } from '../components/ui';
import { AddPlaylist } from '../components/AddPlaylist';
import { ScoreBug } from '../components/GameCard';
import { matchBroadcasts } from '../lib/channelMatch';
import { findPersonal, nowNext, usePersonalChannels } from '../components/tv/personal';
import { PersonalPlayer } from '../components/tv/PersonalPlayer';
import { GuideOverlay } from '../components/tv/GuideOverlay';
import { InfoBanner } from '../components/tv/InfoBanner';
import { navigate } from '../app/router';
import { isFavorite, isOrg, toggleFavorite, useOrganized } from '../components/channels/useOrganized';
import { ChannelList } from '../components/channels/ChannelList';
import { GroupRail, type RailItem } from '../components/channels/GroupRail';
import { GroupPicker, GroupPickerAuto } from '../components/channels/GroupPicker';
import { useSportRail } from '../components/channels/useSportRail';
import { SPORTS, sportInfo, type SportKey } from '../lib/sportsOf';
import { countryName, defaultGroupLabel } from '../lib/channelOrg';
import { QualityButton } from '../components/channels/ChannelMenu';
import { RecordButton } from '../components/tv/RecordButton';
import { applyRemoteCommand, remoteBridge, setRemoteHandler, type RemoteState, type RemoteTarget } from '../lib/remote';
import type { Channel } from '../types';

/** Keys on these targets belong to the element (Space activates buttons/switches). */
const OWN_SPACE = 'button, [role=switch], a, input, select, textarea, [contenteditable]';
const OWN_KEYS = 'input, select, textarea, [contenteditable]';
const BANNER_MS = 4000;

/**
 * Live TV. Keys (on this page): G guide overlay · B or Enter channel banner · ↑/↓ channel
 * up/down (includes My Channels) · digits tune by number · plus the player keys.
 * The lineup is organized (lib/channelOrg.ts): duplicates merged, clean names, a group rail.
 */
export default function WatchPage() {
  const { live, full, groups, org } = useOrganized();
  const channels = useApp((s) => s.channels);
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
  const tune = useApp((s) => s.tune);
  const { recent, railCollapsed, railGroup, railFolds, variantChoice } = useChannelPrefs(useShallow((s) => ({ recent: s.recent, railCollapsed: s.railCollapsed, railGroup: s.railGroup, railFolds: s.railFolds, variantChoice: s.variantChoice })));
  const personalDefs = useTv((s) => s.personal);
  const durations = useTv((s) => s.durations);
  const tvHydrated = useTv((s) => s.hydrated);
  const personalChannels = usePersonalChannels();
  const player = useRef<PlayerHandle>(null);
  const [filter, setFilter] = useState('');
  const [pinned, setPinned] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [bannerAt, setBannerAt] = useState(0);
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  const now = useNow(30_000);
  const minute = Math.floor(now / 60_000) * 60_000;
  const sports = useSportRail(live, org, minute);
  // Re-render while the banner shows so its clock/progress is current and it hides on time.
  const [, setBannerTick] = useState(0);
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

  /** Live channels (organized, visible), then My Channels (personal scheduled channels). */
  const list = useMemo<Channel[]>(() => [...live, ...personalChannels], [live, personalChannels]);
  const listRef = useRef(list);
  listRef.current = list;

  // Reloading playlists resets the tuned channel to a playlist channel; restore a tuned personal channel.
  useEffect(() => {
    if (!tvHydrated || !isPersonalId(lastChannelId) || currentId === lastChannelId) return;
    if (findPersonal(personalDefs, lastChannelId)) useApp.setState({ currentId: lastChannelId });
  }, [tvHydrated, currentId, lastChannelId, personalDefs]);

  // Tuned by a raw playlist id (score card, reminder, old saved channel) that is now merged: use the logical channel.
  useEffect(() => {
    if (!currentId || isPersonalId(currentId)) return;
    const logical = org.alias.get(currentId);
    if (logical && logical !== currentId) useApp.setState({ currentId: logical, lastChannelId: logical });
  }, [currentId, org]);

  const current = useMemo(
    () => list.find((c) => c.id === currentId) ?? full.find((c) => c.id === currentId),
    [list, full, currentId],
  ) ?? list[0];
  const personal = findPersonal(personalDefs, current?.id);
  const lockedOut = useLockedOut(current?.id);
  const ctx = useMemo(() => ({ programs, personal: personalDefs, durations }), [programs, personalDefs, durations]);

  // Banner on every channel change; remember recently watched.
  useEffect(() => {
    if (!current) return;
    setBannerAt(Date.now());
    pushRecent(current.id);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
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
      if (useApp.getState().searchOpen || document.querySelector('.scrim, [role=dialog], [role=menu]')) return;
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

  // Remote Control (phone on the LAN, desktop only): the same actions as the keys above.
  const remoteRef = useRef<Omit<RemoteTarget, 'player'>>();
  remoteRef.current = {
    list,
    currentId: current?.id,
    prevId: prevChannelId,
    tune,
    toggleGuide: () => setGuideOpen((o) => !o),
    notFound: (n) => useApp.getState().toast({ kind: 'error', title: `CH ${n} not found`, ttl: 3000 }),
  };
  // Take commands once the lineup is ready (it organizes after mount); until then they wait.
  const remoteReady = list.length > 0;
  useEffect(() => {
    if (!remoteReady) return;
    return setRemoteHandler((cmd) => {
      if (remoteRef.current) applyRemoteCommand(cmd, { ...remoteRef.current, player: player.current });
    });
  }, [remoteReady]);
  const favList = useMemo(() => list.filter((c) => isFavorite(favorites, c)), [list, favorites]);
  // Now playing → paired phones.
  useEffect(() => {
    const b = remoteBridge();
    if (!b) return;
    const name = (c: Channel) => (isOrg(c) ? c.displayName : c.name);
    const state: RemoteState = { channel: null, favorites: favList.slice(0, 200).map((c) => ({ id: c.id, number: String(c.number), name: name(c) })) };
    if (current) {
      const { now: p, next: n } = nowNext(current.id, now, ctx);
      state.channel = { number: String(current.number), name: name(current) };
      state.currentId = current.id;
      state.title = p?.title;
      state.time = p ? `${fmtTime(p.start)} – ${fmtTime(p.end)}` : undefined;
      state.next = n ? `${fmtTime(n.start)} · ${n.title}` : undefined;
      state.guideOpen = guideOpen;
    }
    b.publish(state);
  }, [current, now, ctx, guideOpen, favList]);

  // Live game on the tuned channel → score bug (broadcast matching uses the raw playlist entries).
  const liveGame = useMemo(() => {
    if (!current || personal) return undefined;
    const ids = isOrg(current) ? current.memberIds : [current.id];
    return Object.values(games).find((g) => {
      if (g.state !== 'in') return false;
      const m = matchBroadcasts(g.broadcasts, channels, overrides)?.channel.id;
      return !!m && ids.includes(m);
    });
  }, [games, channels, overrides, current, personal]);

  // Group rail: All, Favorites, Recently watched, My Channels, Sports (one row per sport), then the
  // visible groups folded by country (home country open).
  const railItems = useMemo<RailItem[]>(() => {
    const counts = new Map<string, number>();
    for (const c of live) counts.set(c.groupKey, (counts.get(c.groupKey) ?? 0) + 1);
    const items: RailItem[] = [
      { key: 'all', label: 'All channels', count: list.length, icon: <LayoutList /> },
      { key: 'fav', label: 'Favorites', count: list.filter((c) => isFavorite(favorites, c)).length, icon: <Heart /> },
      { key: 'recent', label: 'Recently watched', count: recent.filter((id) => list.some((c) => c.id === id)).length, icon: <Clock /> },
    ];
    if (personalChannels.length) items.push({ key: 'mine', label: 'My Channels', count: personalChannels.length, icon: <Tv /> });

    // Sports: every sport is listed (greyed out when the lineup has none), when the lineup has any sports at all.
    if ([...sports.values()].some((b) => b.ids.length)) {
      const open = railFolds['~sports'] ?? true;
      const liveNow = [...sports.values()].reduce((n, b) => n + b.live.size, 0);
      items.push({ key: 'sport:hdr', label: '', count: 0, section: liveNow ? `SPORTS · ${liveNow} ON NOW` : 'SPORTS', sectionKey: '~sports', sectionOpen: open, headerOnly: true });
      if (open) {
        // Sports with channels first (in the standard order), then the rest greyed out.
        const has = (k: SportKey) => sports.get(k)!.ids.length > 0;
        for (const sp of [...SPORTS.filter((x) => has(x.key)), ...SPORTS.filter((x) => !has(x.key))]) {
          const b = sports.get(sp.key)!;
          items.push({ key: `sport:${sp.key}`, label: sp.label, count: b.ids.length, icon: sp.icon, live: b.live.size, dim: !b.ids.length });
        }
      }
    }

    // Groups, folded by country.
    const visibleGroups = groups.filter((g) => !g.hidden && counts.get(g.key));
    const byCountry = new Map<string, typeof visibleGroups>();
    for (const g of visibleGroups) {
      const c = g.country ?? '';
      if (!byCountry.has(c)) byCountry.set(c, []);
      byCountry.get(c)!.push(g);
    }
    const flat = byCountry.size <= 1;
    const home = visibleGroups[0]?.country ?? '';
    let first = true;
    for (const [code, gs] of byCountry) {
      const section = first ? 'GROUPS' : undefined;
      first = false;
      const childLabel = (g: (typeof gs)[number]) => (g.label === defaultGroupLabel(g.country, g.category) ? g.category : g.label);
      if (flat) {
        gs.forEach((g, i) => items.push({ key: g.key, label: code ? childLabel(g) : g.label, count: counts.get(g.key)!, ...(i === 0 ? { section } : {}) }));
        continue;
      }
      const open = railFolds[code] ?? (code === home || gs.some((g) => g.key === railGroup));
      const total = gs.reduce((n, g) => n + counts.get(g.key)!, 0);
      items.push({
        key: `fold:${code}`, label: code ? countryName(code) : 'Other', count: total, fold: true, open, section,
        icon: code ? <b className="ccBadge">{code}</b> : undefined,
      });
      if (open) for (const g of gs) items.push({ key: g.key, label: childLabel(g), count: counts.get(g.key)!, child: true });
    }
    return items;
  }, [live, list, groups, favorites, recent, personalChannels, sports, railFolds, railGroup]);
  const rail = railItems.some((i) => i.key === railGroup && !i.fold && !i.dim) || groups.some((g) => g.key === railGroup) ? railGroup : 'all';
  const toggleFold = (key: string) => {
    const code = key.startsWith('fold:') ? key.slice(5) : key;
    const cur = key.startsWith('fold:') ? !!railItems.find((i) => i.key === key)?.open : (railFolds[code] ?? true);
    setChannelPrefs((p) => ({ railFolds: { ...p.railFolds, [code]: !cur } }));
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (f) {
      // Search covers every visible channel, whatever group is selected.
      return list.filter((c) => {
        const o = isOrg(c) ? c : undefined;
        return String(c.number).startsWith(f) || c.name.toLowerCase().includes(f) || (o && (o.rawName.toLowerCase().includes(f) || o.group.toLowerCase().includes(f)));
      });
    }
    if (rail === 'all') return list;
    if (rail === 'fav') return list.filter((c) => isFavorite(favorites, c));
    if (rail === 'recent') return recent.map((id) => list.find((c) => c.id === id)).filter((c): c is Channel => !!c);
    if (rail === 'mine') return personalChannels;
    if (rail.startsWith('sport:')) {
      const byId = new Map(live.map((c) => [c.id, c]));
      return (sports.get(rail.slice(6) as SportKey)?.ids ?? []).map((id) => byId.get(id)).filter((c): c is (typeof live)[number] => !!c);
    }
    return live.filter((c) => c.groupKey === rail);
  }, [filter, list, live, rail, favorites, recent, personalChannels, sports]);

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
  const fav = isFavorite(favorites, current);
  const idx = list.findIndex((c) => c.id === current.id);
  const step = (d: number) => tune(list[(idx + d + list.length) % list.length].id);
  const prev = prevChannelId ? list.find((c) => c.id === prevChannelId) ?? full.find((c) => c.id === prevChannelId) : undefined;
  const progress = np ? Math.min(100, ((now - np.start) / (np.end - np.start)) * 100) : 0;
  const bannerNow = Date.now();
  const bn = bannerOn ? nowNext(current.id, bannerNow, ctx) : undefined;
  const org1 = isOrg(current) ? current : undefined;
  const overlay = (
    <>
      {liveGame && <ScoreBug g={liveGame} />}
      {bn && <InfoBanner channel={current} now={bn.now} next={bn.next} at={bannerNow} />}
    </>
  );
  const toggleTheater = () => useApp.setState((st) => ({ theater: !st.theater }));
  const railLabel = rail.startsWith('sport:') ? `${sportInfo(rail.slice(6) as SportKey).icon} ${sportInfo(rail.slice(6) as SportKey).label}` : railItems.find((i) => i.key === rail)?.label ?? groups.find((g) => g.key === rail)?.label ?? 'All channels';
  const liveInRail = rail.startsWith('sport:') ? sports.get(rail.slice(6) as SportKey)?.live.size ?? 0 : 0;

  return (
    <div className={`watch ${guideOpen ? 'tvGuideOpen' : ''}`}>
      {pinned && <button className="miniExit" onClick={() => void togglePin()} title="Exit mini player"><PinOff /> Exit mini player</button>}
      <section className="hero">
        <div className="screen">
          {lockedOut ? <LockedScreen /> : personal ? (
            <PersonalPlayer ref={player} def={personal} theater={theater} onTheater={toggleTheater} overlay={overlay} />
          ) : (
            <Player key={`q:${variantChoice[current.id] ?? ''}`} ref={player} channel={current} theater={theater} onTheater={toggleTheater} overlay={overlay} />
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
          <h2>{org1?.displayName ?? current.name}</h2>
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
            <button onClick={() => toggleFavorite(current)}>
              <Heart fill={fav ? 'currentColor' : 'none'} /> {fav ? 'Favorited' : 'Favorite'}
            </button>
            {!personal && <RecordButton channel={current} now={np} />}
            {org1 && <QualityButton c={org1} />}
            {prev && <button onClick={() => tune(prev.id)} title="Last channel (L)"><History /> {isOrg(prev) ? prev.displayName : prev.name}</button>}
            {personal && <button onClick={() => navigate('channels')}><ListVideo /> Edit channel</button>}
            {desktop() && <button onClick={() => void togglePin()} title="Mini player: small, always on top">{pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin' : 'Mini player'}</button>}
          </div>
        </div>
      </section>

      <div className={`lineup ${railCollapsed ? 'railCollapsed' : ''}`}>
        <GroupRail
          items={railItems}
          value={rail}
          onChange={(k) => { setFilter(''); setChannelPrefs({ railGroup: k }); }}
          collapsed={railCollapsed}
          onCollapse={(v) => setChannelPrefs({ railCollapsed: v })}
          onToggle={toggleFold}
          onChoose={() => setPickerOpen(true)}
        />
        <div className="lineupMain">
          <div className="chanBar">
            <div className="lineupTitle">
              <b>{filter.trim() ? 'Search' : railLabel}</b>
              <small>{shown.length.toLocaleString()} channel{shown.length === 1 ? '' : 's'}{liveInRail && !filter.trim() ? ` · ${liveInRail} on now` : ''}{org.rawCount > org.all.length && !filter.trim() && rail === 'all' ? ` · ${(org.rawCount - org.all.length).toLocaleString()} duplicates merged` : ''}</small>
            </div>
            <label className="lineupSearch">
              <Search />
              <input className="field small" placeholder="Filter or channel #" aria-label="Search channels" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
            <button className="ghost" onClick={() => setPickerOpen(true)} title="Choose countries and categories"><SlidersHorizontal /> Choose channels</button>
          </div>
          <ChannelList
            rows={shown}
            currentId={current.id}
            onTune={(id) => tune(id)}
            now={now}
            ctx={ctx}
            favorites={favorites}
            locked={locked}
            empty={rail === 'fav' && !filter ? 'No favorites yet. Use the star on a channel.' : rail === 'recent' && !filter ? 'Channels you watch show up here.' : 'No channels match.'}
          />
        </div>
      </div>
      {guideOpen && <GuideOverlay rows={list} currentId={current.id} onTune={(id) => tune(id)} onClose={() => setGuideOpen(false)} />}
      {pickerOpen ? <GroupPicker onClose={() => setPickerOpen(false)} /> : <GroupPickerAuto />}
    </div>
  );
}
