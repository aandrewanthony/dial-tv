import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays, Clock, Gamepad2, Grid2x2, Home, Lock, Radio, Search, Settings, Ticket, Trophy, Tv, X, Flame, Bell, Zap,
} from 'lucide-react';
import { navigate, useRoute, type Route } from './router';
import { orderedChannels, sha256, showScore, useApp } from '../store/app';
import { useEngine } from '../hooks/useEngine';
import { SearchPalette } from '../components/SearchPalette';
import { Modal } from '../components/ui';
import { clutchInfo } from '../lib/sports';
import HomePage from '../pages/HomePage';
import WatchPage from '../pages/WatchPage';

const GuidePage = lazy(() => import('../pages/GuidePage'));
const SportsPage = lazy(() => import('../pages/SportsPage'));
const FantasyPage = lazy(() => import('../pages/FantasyPage'));
const PicksPage = lazy(() => import('../pages/PicksPage'));
const MultiviewPage = lazy(() => import('../pages/MultiviewPage'));
const SchedulePage = lazy(() => import('../pages/SchedulePage'));
const SettingsPage = lazy(() => import('../pages/SettingsPage'));

const NAV: [Route, typeof Tv, string][] = [
  ['home', Home, 'Game Day'],
  ['watch', Tv, 'Watch'],
  ['guide', CalendarDays, 'Guide'],
  ['sports', Trophy, 'Sports'],
  ['fantasy', Gamepad2, 'Fantasy'],
  ['picks', Ticket, 'Picks'],
  ['multiview', Grid2x2, 'Multiview'],
  ['schedule', Clock, 'Schedule'],
  ['settings', Settings, 'Settings'],
];

const TITLES: Record<Route, [string, string]> = {
  home: ['GAME DAY', 'Your Sports Command Center'],
  watch: ['LIVE', 'Live Television'],
  guide: ['LISTINGS', 'Program Guide'],
  sports: ['SCORES', 'Sports Center'],
  fantasy: ['SLEEPER', 'Fantasy Live'],
  picks: ['PICK’EM', 'Picks & Odds'],
  multiview: ['2×2', 'Multiview'],
  schedule: ['PLANNER', 'My Schedule'],
  settings: ['SYSTEM', 'Settings'],
};

export default function App() {
  useEngine();
  const { route } = useRoute();
  const hydrated = useApp((s) => s.hydrated);
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const searchOpen = useApp((s) => s.searchOpen);
  const density = useApp((s) => s.settings.density);
  const accent = useApp((s) => s.settings.accent);
  const theater = useApp((s) => s.theater);
  const liveCount = useApp((s) => Object.values(s.games).filter((g) => g.state === 'in').length);

  useGlobalKeys(route);

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent);
  }, [accent]);

  const [eyebrow, title] = TITLES[route];

  return (
    <div className={`app ${density} ${theater && route === 'watch' ? 'theater' : ''}`}>
      <aside className="nav">
        <div className="brand"><Radio />DIAL<span>TV</span></div>
        {NAV.map(([id, Icon, label]) => (
          <button key={id} className={route === id ? 'active' : ''} onClick={() => navigate(id)}>
            <Icon />{label}
            {id === 'sports' && liveCount > 0 && <em className="badge">{liveCount}</em>}
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
        {!hydrated ? <div className="loadingPage">Loading…</div> : (
          <Suspense fallback={<div className="loadingPage">Loading…</div>}>
            {route === 'home' && <HomePage />}
            {route === 'watch' && <WatchPage />}
            {route === 'guide' && <GuidePage />}
            {route === 'sports' && <SportsPage />}
            {route === 'fantasy' && <FantasyPage />}
            {route === 'picks' && <PicksPage />}
            {route === 'multiview' && <MultiviewPage />}
            {route === 'schedule' && <SchedulePage />}
            {route === 'settings' && <SettingsPage />}
          </Suspense>
        )}
      </main>
      <BottomLine />
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

/** ESPN-style bottom line ticker of live and recent scores. */
function BottomLine() {
  const games = useApp((s) => s.games);
  const settings = useApp((s) => s.settings);
  const favTeams = useApp((s) => s.favTeams);
  const items = useMemo(() => {
    const now = Date.now();
    return Object.values(games)
      .filter((g) => g.state === 'in' || (g.state === 'post' && now - g.start < 10 * 3600_000) || (g.state === 'pre' && g.start - now < 3 * 3600_000))
      .sort((a, b) => {
        const fa = favTeams.some((t) => t.endsWith(':' + a.home.abbr) || t.endsWith(':' + a.away.abbr)) ? 1 : 0;
        const fb = favTeams.some((t) => t.endsWith(':' + b.home.abbr) || t.endsWith(':' + b.away.abbr)) ? 1 : 0;
        const order = { in: 0, pre: 1, post: 2 } as const;
        return fb - fa || order[a.state] - order[b.state] || clutchInfo(b).score - clutchInfo(a).score || a.start - b.start;
      })
      .slice(0, 40);
  }, [games, favTeams]);
  if (!items.length) return null;
  const render = (k: string) => items.map((g) => {
    const vis = showScore({ settings }, g.id);
    const c = clutchInfo(g);
    return (
      <span key={k + g.id} className={`tick ${g.state} ${c.clutch ? 'clutch' : ''}`} onClick={() => navigate('sports')}>
        <i>{g.league.toUpperCase()}</i>
        {g.away.abbr} {g.state !== 'pre' && vis ? g.awayScore : ''} · {g.home.abbr} {g.state !== 'pre' && vis ? g.homeScore : ''}
        <em>{g.state === 'pre' ? new Date(g.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : vis ? g.statusText : g.state === 'in' ? 'LIVE' : 'FINAL'}</em>
      </span>
    );
  });
  return (
    <div className="bottomLine" aria-label="Scores ticker">
      <div className="tickLabel">SCORES</div>
      <div className="tickTrack"><div className="tickInner" style={{ animationDuration: `${Math.max(30, items.length * 5)}s` }}>{render('a')}{render('b')}</div></div>
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
      const list = orderedChannels(s);
      const idx = list.findIndex((c) => c.id === s.currentId);
      const go = (id?: string) => {
        if (!id) return;
        s.tune(id);
        if (route !== 'watch' && route !== 'multiview') navigate('watch');
      };
      if (/^[0-9]$/.test(e.key)) {
        digits += e.key;
        clearTimeout(digitTimer);
        useApp.setState({ toasts: [...s.toasts.filter((x) => x.id !== 'chnum'), { id: 'chnum', kind: 'info', title: `CH ${digits}` }] });
        digitTimer = setTimeout(() => {
          const ch = list.find((c) => String(c.number) === digits);
          useApp.getState().dismissToast('chnum');
          digits = '';
          go(ch?.id);
        }, 1200);
        return;
      }
      switch (e.key) {
        case 'ArrowUp':
        case 'PageUp':
          if (route === 'watch') { e.preventDefault(); go(list[(idx - 1 + list.length) % list.length]?.id); }
          break;
        case 'ArrowDown':
        case 'PageDown':
          if (route === 'watch') { e.preventDefault(); go(list[(idx + 1) % list.length]?.id); }
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
    ['I', 'Stream health'], ['[ / ]', 'Volume down / up'], ['G', 'Guide'], ['S', 'Sports'], ['H', 'Game Day'], ['V', 'Multiview'], ['Ctrl K', 'Search'],
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
  const blocked = !!pinHash && !unlocked && !!currentId && locked.includes(currentId);
  if (!blocked) return null;
  const leave = () => {
    const s = useApp.getState();
    const safe = orderedChannels(s).find((c) => !locked.includes(c.id));
    useApp.setState({ currentId: s.prevChannelId && !locked.includes(s.prevChannelId) ? s.prevChannelId : safe?.id });
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
