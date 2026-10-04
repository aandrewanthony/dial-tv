import { useHealthDeps } from './channels/useOrganized';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Search, Star, Trophy, Tv } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { orderedChannels, useApp } from '../store/app';
import { navigate } from '../app/router';
import { matchBroadcasts } from '../lib/channelMatch';
import { leagueLabel } from '../lib/sports';
import { fmtDay, fmtTime } from './ui';

interface Result {
  key: string;
  kind: 'channel' | 'program' | 'game' | 'team';
  title: string;
  sub: string;
  run: () => void;
}

/** Unified global search across channels, programs, games, teams and leagues. */
export function SearchPalette() {
  const { channels, channelOrder, hidden, favorites, games, overrides, favTeams, programs } = useApp(useShallow((s) => ({
    channels: s.channels, channelOrder: s.channelOrder, hidden: s.hidden, favorites: s.favorites, games: s.games,
    overrides: s.networkOverrides, favTeams: s.favTeams, programs: s.programs,
  })));
  const { tune, update } = useApp.getState();
  const healthDeps = useHealthDeps();
  const ordered = useMemo(() => orderedChannels({ channels, channelOrder, hidden }), [channels, channelOrder, hidden, ...healthDeps]); // eslint-disable-line react-hooks/exhaustive-deps
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useApp.setState({ searchOpen: false });

  const results = useMemo<Result[]>(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) {
      return ordered.filter((c) => favorites.includes(c.id)).slice(0, 8).map((c) => ({
        key: c.id, kind: 'channel', title: `${c.number} · ${c.name}`, sub: 'Favorite channel',
        run: () => { tune(c.id); navigate('watch'); },
      }));
    }
    const out: Result[] = [];
    for (const c of ordered) {
      if (c.name.toLowerCase().includes(needle) || String(c.number) === needle || c.group.toLowerCase().includes(needle)) {
        out.push({ key: c.id, kind: 'channel', title: `${c.number} · ${c.name}`, sub: c.group, run: () => { tune(c.id); navigate('watch'); } });
      }
      if (out.length > 12) break;
    }
    const live = Object.values(games).filter((g) => g.state !== 'post' || Date.now() - g.start < 12 * 3600_000);
    const teams = new Map<string, { league: string; abbr: string; name: string }>();
    for (const g of live) {
      const hay = `${g.home.name} ${g.away.name} ${g.home.abbr} ${g.away.abbr} ${leagueLabel(g.league)}`.toLowerCase();
      if (hay.includes(needle)) {
        const m = matchBroadcasts(g.broadcasts, channels, overrides);
        out.push({
          key: g.id, kind: 'game', title: `${g.away.name} @ ${g.home.name}`,
          sub: `${leagueLabel(g.league)} · ${g.state === 'in' ? 'LIVE' : g.state === 'post' ? 'Final' : `${fmtDay(g.start)} ${fmtTime(g.start)}`} · ${g.broadcasts[0] ?? 'TBD'}${m ? ` → ${m.channel.name}` : ''}`,
          run: () => { if (m && g.state === 'in') { tune(m.channel.id); navigate('watch'); } else navigate('sports'); },
        });
      }
      for (const t of [g.home, g.away]) {
        if (`${t.name} ${t.abbr}`.toLowerCase().includes(needle)) teams.set(`${g.league}:${t.abbr}`, { league: g.league, abbr: t.abbr, name: t.name });
      }
    }
    for (const [key, t] of teams) {
      const fav = favTeams.includes(key);
      out.push({
        key: 'team:' + key, kind: 'team', title: `${fav ? '★ ' : ''}${t.name}`, sub: `${t.league.toUpperCase()} · ${fav ? 'Remove from' : 'Add to'} favorite teams`,
        run: () => update((st) => ({ favTeams: fav ? st.favTeams.filter((x) => x !== key) : [...st.favTeams, key] })),
      });
    }
    const now = Date.now();
    let n = 0;
    for (const p of programs) {
      if (p.end < now || !p.title.toLowerCase().includes(needle)) continue;
      const ch = channels.find((c) => c.id === p.channelId);
      out.push({
        key: p.id, kind: 'program', title: p.title, sub: `${ch?.name ?? ''} · ${p.start <= now ? 'On now' : `${fmtDay(p.start)} ${fmtTime(p.start)}`}`,
        run: () => { if (p.start <= now && ch) { tune(ch.id); navigate('watch'); } else navigate('guide', String(p.start)); },
      });
      if (++n > 15) break;
    }
    return out.slice(0, 40);
  }, [q, ordered, channels, favorites, games, overrides, favTeams, programs]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const icon = (k: Result['kind']) => (k === 'channel' ? <Tv /> : k === 'program' ? <CalendarDays /> : k === 'team' ? <Star /> : <Trophy />);

  return (
    <div className="scrim" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palIn">
          <Search />
          <input
            autoFocus
            placeholder="Channel, show, team, league…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(x + 1, results.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(x - 1, 0)); }
              if (e.key === 'Enter' && results[sel]) { results[sel].run(); if (results[sel].kind !== 'team') close(); }
            }}
          />
        </div>
        <div className="palList" ref={listRef}>
          {results.map((r, i) => (
            <button key={r.key} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onClick={() => { r.run(); if (r.kind !== 'team') close(); }}>
              {icon(r.kind)}<div><b>{r.title}</b><small>{r.sub}</small></div>
            </button>
          ))}
          {!results.length && <div className="palEmpty">{q ? 'No matches' : 'Start typing — or favorite some channels for quick access.'}</div>}
        </div>
      </div>
    </div>
  );
}
