import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CircleDot, CalendarDays, CalendarClock, Clapperboard, Gamepad2, Grid2x2, Home, ListVideo, Lock, Radio, Search, Settings, Shield, Ticket, Trophy, Tv, X, Flame, Bell, Zap,
} from 'lucide-react';
import { navigate, sectionOf, useRoute, type Route, type Section } from './router';
import { lockedSet, orderedChannels, sha256, showScore, useApp } from '../store/app';
import { useEngine } from '../hooks/useEngine';
import { dvrBridge, initDvr, useDvr } from '../lib/dvr';
import { startDeadChecker } from '../lib/deadChecker';
import { SearchPalette } from '../components/SearchPalette';
import { Modal } from '../components/ui';
import { clutchInfo } from '../lib/sports';
import { Onboarding, useOnboardingGate } from '../components/sports/Onboarding';
import HomePage from '../pages/HomePage';
import WatchPage from '../pages/WatchPage';
import { useRemoteCommands } from '../lib/remote';

const GuidePage = lazy(() => import('../pages/GuidePage'));
const SportsPage = lazy(() => import('../pages/SportsPage'));
const FantasyPage = lazy(() => import('../pages/FantasyPage'));
const BetsPage = lazy(() => import('../pages/BetsPage'));
const MoviesPage = lazy(() => import('../pages/MoviesPage'));
const ChannelsPage = lazy(() => import('../pages/ChannelsPage'));
const TeamsPage = lazy(() => import('../pages/TeamsPage'));
const MultiviewPage = lazy(() => import('../pages/MultiviewPage'));
const SchedulePage = lazy(() => import('../pages/SchedulePage'));
const SettingsPage = lazy(() => import('../pages/SettingsPage'));
const RecordingsPage = lazy(() => import('../pages/RecordingsPage'));

const NAV: Record<Section, [Route, typeof Tv, string][]> = {
  tv: [
    ['watch', Tv, 'Live TV'],
    ['guide', CalendarDays, 'Guide'],
    ['movies', Clapperboard, 'Movies & Series'],
    ['recordings', CircleDot, 'Recordings'],
    ['channels', ListVideo, 'My Channels'],
    ['multiview', Grid2x2, 'Multiview'],
  ],
  sports: [
    ['home', Home, 'Game Day'],
    ['sports', Trophy, 'Scores'],
    ['teams', Shield, 'My Teams'],
    ['fantasy', Gamepad2, 'Fantasy'],
    ['bets', Ticket, 'Bets'],
  ],
};
const SHARED_NAV: [Route, typeof Tv, string][] = [
  ['schedule', CalendarClock, 'Smart Schedule'],
  ['settings', Settings, 'Settings'],
];

const TITLES: Record<Route, [string, string]> = {
  home: ['GAME DAY', 'Your Sports Command Center'],
  watch: ['LIVE', 'Live TV'],
  guide: ['LISTINGS', 'Program Guide'],
  sports: ['SCORES', 'Scores'],
  fantasy: ['FANTASY', 'Fantasy Live'],
  bets: ['SPORTSBOOKS', 'Bets & Odds'],
  movies: ['ON DEMAND', 'Movies & Series'],
  recordings: ['DVR', 'Recordings'],
  channels: ['CABLE MODE', 'My Channels'],
  teams: ['FAVORITES', 'My Teams'],
  multiview: ['2×2', 'Multiview'],
  schedule: ['PLANNER', 'Smart Schedule'],
  settings: ['SYSTEM', 'Settings'],
};

/** Remote commands open Live TV when they arrive on another page. */
const openWatch = () => navigate('watch');

export default function App() {
  useEngine();
  useEffect(() => initDvr(), []);
  useEffect(() => startDeadChecker(), []);
  const { route } = useRoute();
  useRemoteCommands(openWatch, route === 'watch');
  const hydrated = useApp((s) => s.hydrated);
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const searchOpen = useApp((s) => s.searchOpen);
  const density = useApp((s) => s.settings.density);
  const accent = useApp((s) => s.settings.accent);
  const theater = useApp((s) => s.theater);
  // Store may expose a storage failure (IndexedDB unreadable); typed loosely so this works either way.
  const storageError = useApp((s) => (s as { storageError?: string }).storageError);
  const recCount = useDvr((s) => s.recordings.filter((r) => r.status === 'recording').length);
  const liveCount = useApp((s) => Object.values(s.games).filter((g) => g.state === 'in').length);

  // First-run sports onboarding: shown on Game Day (the Sports landing page) until done or skipped.
  const onboarding = useOnboardingGate(route);
  useGlobalKeys(route);

  const theme = useApp((s) => s.settings.theme);
  const resolved = useResolvedTheme(theme);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    try { localStorage.setItem('dialtv.theme', resolved); } catch { /* pre-paint hint only */ }
    // A near-white accent disappears on the light theme; use near-black there instead.
    root.style.setProperty('--accent', resolved === 'light' && isPale(accent) ? '#15181e' : accent);
  }, [accent, resolved]);

  const [eyebrow, title] = TITLES[route];
  // Remember which section you were in when on a shared page (Schedule / Settings).
  const [section, setSection] = useState<Section>(() => sectionOf(route) ?? 'tv');
  useEffect(() => { const s = sectionOf(route); if (s) setSection(s); }, [route]);

  return (
    <div className={`app ${density} ${theater && route === 'watch' ? 'theater' : ''}`}>
      <aside className="nav">
        <div className="brand"><Radio />DIAL<span>TV</span></div>
        <div className="sectionSwitch" role="tablist" aria-label="Section">
          <button role="tab" aria-selected={section === 'tv'} className={section === 'tv' ? 'on' : ''} onClick={() => navigate('watch')}><Tv /> TV</button>
          <button role="tab" aria-selected={section === 'sports'} className={section === 'sports' ? 'on' : ''} onClick={() => navigate('home')}><Trophy /> Sports</button>
        </div>
        {[...NAV[section].filter(([id]) => id !== 'recordings' || dvrBridge()), ...SHARED_NAV].map(([id, Icon, label], i) => (
          <button key={id} className={`${route === id ? 'active' : ''} ${i === NAV[section].length ? 'navGap' : ''}`} onClick={() => navigate(id)}>
            <Icon />{label}
            {id === 'sports' && liveCount > 0 && <em className="badge">{liveCount}</em>}
            {id === 'recordings' && recCount > 0 && <em className="badge" title="Recording now">● {recCount}</em>}
          </button>
        ))}
        <div className="navBottom">
          <kbd>Ctrl K</kbd> search · <kbd>?</kbd> keys
          <br /><span>WEB • WIN • MAC</span>
        </div>
      </aside>
      <main>
        <header className="top">
          <div><small>{eyebrow}</small><h1>{title}</h1></div>
          <button className="searchBtn" onClick={() => useApp.setState({ searchOpen: true })}>
            <Search /><span>Search channels, shows, teams…</span><kbd>Ctrl K</kbd>
          </button>
        </header>
        {storageError && <div className="banner warn storageBanner" role="alert"><AlertTriangle /> {storageError}</div>}
        {!hydrated ? <div className="loadingPage">Loading…</div> : (
          <Suspense fallback={<div className="loadingPage">Loading…</div>}>
            {route === 'home' && <HomePage />}
            {route === 'watch' && <WatchPage />}
            {route === 'guide' && <GuidePage />}
            {route === 'sports' && <SportsPage />}
            {route === 'fantasy' && <FantasyPage />}
            {route === 'bets' && <BetsPage />}
            {route === 'movies' && <MoviesPage />}
            {route === 'recordings' && <RecordingsPage />}
            {route === 'channels' && <ChannelsPage />}
            {route === 'teams' && <TeamsPage />}
            {route === 'multiview' && <MultiviewPage />}
            {route === 'schedule' && <SchedulePage />}
            {route === 'settings' && <SettingsPage />}
          </Suspense>
        )}
      </main>
      {onboarding && <Onboarding />}
      {searchOpen && <SearchPalette />}
      <LockGate />
      <ShortcutHelp />
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <div className="tIcon">{t.kind === 'clutch' ? <Flame /> : t.kind === 'reminder' ? <Bell /> : t.kind === 'redzone' ? <Zap /> : null}</div>
            <div className="tBody"><b>{t.title}</b>{t.body && <span>{t.body}</span>}</div>
            {t.action && <button onClick={() => { t.action!.run(); if (location.hash !== '#/watch' && location.hash !== '#/multiview') navigate('watch'); dismiss(t.id); }}>{t.action.label}</button>}
            <button className="icon" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Channel number entry, channel up/down, last channel, and page shortcuts. */
function useGlobalKeys(route: Route) {
  useEffect(() => {
    let digits = '';
    let digitTimer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useApp.setState({ searchOpen: true });
        return;
      }
      if (t?.closest?.('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (useApp.getState().searchOpen) return;
      const s = useApp.getState();
      const go = (id?: string) => {
        if (!id) return;
        // On Multiview the channel goes into a tile (first empty, else the focused one).
        if (route === 'multiview') { window.dispatchEvent(new CustomEvent('dial:mvtune', { detail: id })); return; }
        s.tune(id);
        if (route !== 'watch') navigate('watch');
      };
      const zap = (d: number) => {
        const list = orderedChannels(s);
        const idx = list.findIndex((c) => c.id === s.currentId);
        go(list[(idx + d + list.length) % list.length]?.id);
      };
      if (/^[0-9]$/.test(e.key)) {
        digits += e.key;
        clearTimeout(digitTimer);
        useApp.setState((st) => ({ toasts: [...st.toasts.filter((x) => x.id !== 'chnum'), { id: 'chnum', kind: 'info', title: `CH ${digits}` }] }));
        digitTimer = setTimeout(() => {
          const typed = digits;
          const app = useApp.getState();
          const ch = orderedChannels(app).find((c) => String(c.number) === typed);
          app.dismissToast('chnum');
          digits = '';
          if (ch) go(ch.id);
          else app.toast({ kind: 'error', title: `CH ${typed} not found`, ttl: 3000 });
        }, 1200);
        return;
      }
      switch (e.key) {
        case 'ArrowUp':
        case 'PageUp':
          if (route === 'watch') { e.preventDefault(); zap(-1); }
          break;
        case 'ArrowDown':
        case 'PageDown':
          if (route === 'watch') { e.preventDefault(); zap(1); }
          break;
        case 'l': go(s.prevChannelId); break;
        case 'g': navigate('guide'); break;
        case 's': navigate('sports'); break;
        case 'h': navigate('home'); break;
        case 'v': navigate('multiview'); break;
        case '?': window.dispatchEvent(new Event('dial:help')); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route]);
}

function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen((o) => !o);
    window.addEventListener('dial:help', on);
    return () => window.removeEventListener('dial:help', on);
  }, []);
  if (!open) return null;
  const rows: [string, string][] = [
    ['0–9', 'Type a channel number'], ['↑ / ↓', 'Channel up / down (Watch)'], ['L', 'Last channel'],
    ['Space / K', 'Play / pause'], ['M', 'Mute'], ['F', 'Fullscreen'], ['T', 'Theater mode'], ['P', 'Picture-in-picture'],
    ['I', 'Stream health'], ['[ / ]', 'Volume down / up'], ['G', 'Guide (over live TV on Live TV)'], ['B / Enter', 'Channel info banner (Live TV)'], ['← / →', 'Skip 10 s in movies (Shift: 30 s)'], ['S', 'Scores'], ['H', 'Game Day'], ['V', 'Multiview'], ['Ctrl K', 'Search'],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setOpen(false)}>
      <div className="keys">{rows.map(([k, d]) => <div key={k}><kbd>{k}</kbd><span>{d}</span></div>)}</div>
    </Modal>
  );
}

/** Parental lock: tuning to a locked channel requires the PIN once per session. */
function LockGate() {
  const currentId = useApp((s) => s.currentId);
  const locked = useApp((s) => s.settings.locked);
  const pinHash = useApp((s) => s.settings.lockPin);
  const unlocked = useApp((s) => s.unlocked);
  const [pin, setPin] = useState('');
  const [bad, setBad] = useState(false);
  const lockedIds = useApp((s) => lockedSet(s));
  const blocked = !!pinHash && !unlocked && !!currentId && lockedIds.has(currentId);
  if (!blocked) return null;
  const leave = () => {
    const s = useApp.getState();
    const safe = orderedChannels(s).find((c) => !lockedIds.has(c.id));
    const id = s.prevChannelId && !lockedIds.has(s.prevChannelId) ? s.prevChannelId : safe?.id;
    // lastChannelId too, so the next launch doesn't reopen the locked channel.
    useApp.setState({ currentId: id, lastChannelId: id });
  };
  return (
    <Modal title="Channel locked" onClose={leave}>
      <form className="pinForm" onSubmit={async (e) => {
        e.preventDefault();
        if ((await sha256(pin)) === pinHash) useApp.setState({ unlocked: true });
        else { setBad(true); setPin(''); }
      }}>
        <Lock />
        <p>Enter the parental PIN to watch this channel.</p>
        <input autoFocus type="password" inputMode="numeric" value={pin} onChange={(e) => { setPin(e.target.value); setBad(false); }} aria-label="PIN" />
        {bad && <small className="err">Wrong PIN</small>}
        <div className="row"><button type="button" className="ghost" onClick={leave}>Cancel</button><button className="primary">Unlock</button></div>
      </form>
    </Modal>
  );
}

/** The theme to show: the setting, or the operating system's preference for "system". */
function useResolvedTheme(theme: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : undefined;
  const [osLight, setOsLight] = useState(() => !!query?.matches);
  useEffect(() => {
    if (!query) return;
    const on = () => setOsLight(query.matches);
    query.addEventListener?.('change', on);
    return () => query.removeEventListener?.('change', on);
  }, [query?.media]); // eslint-disable-line react-hooks/exhaustive-deps
  if (theme === 'system') return osLight ? 'light' : 'dark';
  return theme ?? 'dark';
}

/** Very light colour (e.g. the white accent swatch). */
function isPale(hex: string) {
  const m = /^#([0-9a-f]{6})/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 200;
}
