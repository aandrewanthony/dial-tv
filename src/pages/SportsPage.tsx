import { useMemo, useState } from 'react';
import { Flame, Loader2, RefreshCw, Star } from 'lucide-react';
import { useApp } from '../store/app';
import { useRankedGames } from '../hooks/useSports';
import { GameCard } from '../components/GameCard';
import { TeamPicker } from '../components/TeamPicker';
import { Empty, Toggle, fmtDay } from '../components/ui';
import { LEAGUES, leagueLabel } from '../lib/sports';
import { HOUR, startOfDay } from '../lib/scheduler';
import { pollSports } from '../hooks/useEngine';
import type { League } from '../types';

export default function SportsPage() {
  const leagues = useApp((s) => s.leagues);
  const favTeams = useApp((s) => s.favTeams);
  const updated = useApp((s) => s.sportsUpdated);
  const error = useApp((s) => s.sportsError);
  const spoiler = useApp((s) => s.settings.spoilerShield);
  const update = useApp((s) => s.update);
  const [league, setLeague] = useState<League | 'all'>('all');
  const [day, setDay] = useState(() => startOfDay(Date.now()));
  const [mode, setMode] = useState<'all' | 'live' | 'mine'>('all');
  const [sort, setSort] = useState<'time' | 'watch'>('time');
  const [picking, setPicking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const dayEnd = startOfDay(day + 26 * HOUR);
  const ranked = useRankedGames((g) => g.start >= day && g.start < dayEnd);
  const list = useMemo(() => {
    let r = ranked.filter(({ g, stakes }) =>
      (league === 'all' || g.league === league) &&
      (mode !== 'live' || g.state === 'in') &&
      (mode !== 'mine' || stakes || favTeams.includes(`${g.league}:${g.home.abbr}`) || favTeams.includes(`${g.league}:${g.away.abbr}`)),
    );
    if (sort === 'time') {
      const order = { in: 0, pre: 1, post: 2 } as const;
      r = [...r].sort((a, b) => order[a.g.state] - order[b.g.state] || a.g.start - b.g.start);
    }
    return r;
  }, [ranked, league, mode, sort, favTeams]);

  const byLeague = useMemo(() => {
    const m = new Map<League, typeof list>();
    for (const r of list) m.set(r.g.league, [...(m.get(r.g.league) ?? []), r]);
    return [...m.entries()].sort((a, b) => leagues.indexOf(a[0]) - leagues.indexOf(b[0]));
  }, [list, leagues]);

  const days = Array.from({ length: 8 }, (_, i) => startOfDay(startOfDay(Date.now()) + (i - 1) * 24 * HOUR + 2 * HOUR));
  const liveCount = ranked.filter((r) => r.g.state === 'in').length;

  return (
    <div className="sportsPage">
      <div className="guideBar">
        <div className="chips">
          <button className={league === 'all' ? 'on' : ''} onClick={() => setLeague('all')}>ALL</button>
          {LEAGUES.filter((l) => leagues.includes(l.id)).map((l) => (
            <button key={l.id} className={league === l.id ? 'on' : ''} onClick={() => setLeague(l.id)}>{l.label}</button>
          ))}
        </div>
        <div className="chips">
          <button onClick={() => setPicking(true)}><Star /> Teams</button>
          <button
            title="Refresh now"
            onClick={async () => { setRefreshing(true); await pollSports(true); setRefreshing(false); }}
          >{refreshing ? <Loader2 className="spin" /> : <RefreshCw />}</button>
        </div>
      </div>
      <div className="guideBar">
        <div className="chips">
          {days.map((d) => <button key={d} className={d === day ? 'on' : ''} onClick={() => setDay(d)}>{fmtDay(d)}</button>)}
        </div>
        <div className="chips">
          <button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>All games</button>
          <button className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>Live {liveCount ? `(${liveCount})` : ''}</button>
          <button className={mode === 'mine' ? 'on' : ''} onClick={() => setMode('mine')}>My teams + fantasy</button>
          <button className={sort === 'watch' ? 'on' : ''} onClick={() => setSort(sort === 'watch' ? 'time' : 'watch')}><Flame /> Watchability</button>
          <label className="inlineToggle">Spoiler shield <Toggle on={spoiler} onChange={(v) => update((s) => ({ settings: { ...s.settings, spoilerShield: v } }))} /></label>
        </div>
      </div>
      {error && <div className="banner warn">{error}</div>}
      {!list.length ? (
        <Empty title={updated ? 'No games' : 'Loading scores…'}>{updated ? 'Nothing matches these filters for this day.' : ''}</Empty>
      ) : sort === 'watch' ? (
        <div className="gameGrid">{list.map((r) => <GameCard key={r.g.id} g={r.g} stakes={r.stakes} />)}</div>
      ) : (
        byLeague.map(([lg, rs]) => (
          <section key={lg}>
            <h3 className="sectionTitle">{leagueLabel(lg)} · {rs.length}</h3>
            <div className="gameGrid">{rs.map((r) => <GameCard key={r.g.id} g={r.g} stakes={r.stakes} />)}</div>
          </section>
        ))
      )}
      <p className="muted small">Scores, schedules and lines via ESPN’s public scoreboard{updated ? ` · updated ${new Date(updated).toLocaleTimeString()}` : ''}. Live games refresh every 30s.</p>
      {picking && <TeamPicker onClose={() => setPicking(false)} />}
    </div>
  );
}
