import { useMemo, useState } from 'react';
import { Gamepad2, Grid2x2, Loader2, LogOut, Play, RefreshCw } from 'lucide-react';
import { useApp } from '../store/app';
import { useFantasy } from '../store/fantasy';
import { sleeperProvider } from '../providers/sleeper';
import type { FantasyLeague, FantasyPlayer, FantasyTeam } from '../providers/types';
import { useRankedGames } from '../hooks/useSports';
import { GameCard } from '../components/GameCard';
import { Empty, fmtDay, fmtTime } from '../components/ui';
import { matchBroadcasts } from '../lib/channelMatch';
import { navigate } from '../app/router';
import type { SportEvent } from '../types';

function Connect() {
  const set = useApp((s) => s.set);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [user, setUser] = useState<{ userId: string; displayName: string }>();
  const [leagues, setLeagues] = useState<FantasyLeague[]>();

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    try {
      const u = await sleeperProvider.findUser(username);
      const { season } = await sleeperProvider.currentWeek();
      const ls = await sleeperProvider.leagues(u.userId, season);
      setUser(u);
      setLeagues(ls);
      if (!ls.length) setErr(`No ${season} NFL leagues for ${u.displayName}.`);
    } catch (e) {
      setErr((e as Error).message === 'Not found' ? 'No Sleeper user with that username.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const choose = (l: FantasyLeague) => {
    set({ fantasy: { provider: 'sleeper', username, userId: user!.userId, displayName: user!.displayName, leagueId: l.id, leagueName: l.name } });
    useFantasy.setState({ leagues: leagues ?? [], matchup: undefined });
    setTimeout(() => void useFantasy.getState().refresh(), 0);
  };

  return (
    <div className="connect panel">
      <Gamepad2 className="big" />
      <h2>Connect your Sleeper league</h2>
      <p className="muted">Read-only and public — just your Sleeper username. No password, nothing is posted. You’ll get a live matchup board, red-zone alerts for your starters, and games ranked by how much they matter to your matchup.</p>
      {!leagues ? (
        <form onSubmit={lookup} className="row">
          <input className="field" autoFocus placeholder="Sleeper username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <button className="primary" disabled={!username || busy}>{busy ? <Loader2 className="spin" /> : 'Find leagues'}</button>
        </form>
      ) : (
        <div className="col">
          <p>Pick a league for <b>{user?.displayName}</b>:</p>
          {leagues.map((l) => (
            <button key={l.id} className="leagueBtn" onClick={() => choose(l)}>
              {l.avatar && <img src={l.avatar} alt="" width={28} height={28} />}{l.name}<small>{l.season}</small>
            </button>
          ))}
          <button className="ghost" onClick={() => setLeagues(undefined)}>Back</button>
        </div>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function playerGame(p: FantasyPlayer, games: SportEvent[]) {
  if (!p.team) return undefined;
  return games.find((g) => g.league === 'nfl' && (g.home.abbr === p.team || g.away.abbr === p.team) && g.start > Date.now() - 5 * 86400e3 && g.start < Date.now() + 6 * 86400e3);
}

function Roster({ team, side }: { team: FantasyTeam; side: 'me' | 'opp' }) {
  const players = useFantasy((s) => s.players);
  const games = useApp((s) => s.games);
  const channels = useApp((s) => s.channels);
  const overrides = useApp((s) => s.networkOverrides);
  const tune = useApp((s) => s.tune);
  const list = Object.values(games);
  return (
    <div className={`roster ${side}`}>
      {team.starters.map((id) => {
        const p = players[id] ?? { id, name: id, position: '?' };
        const g = playerGame(p, list);
        const pts = team.playerPoints[id];
        const pos = g?.situation?.possessionTeamId;
        const hasBall = g && pos && (g.home.abbr === p.team ? g.home.id : g.away.id) === pos;
        const rz = hasBall && g?.situation?.isRedZone;
        const m = g && g.state === 'in' ? matchBroadcasts(g.broadcasts, channels, overrides) : null;
        return (
          <div key={id} className={`rp ${rz ? 'rz' : ''} ${g?.state ?? ''}`}>
            <span className="pos">{p.position}</span>
            <div className="pn">
              <b>{p.name}</b>
              <small>
                {p.team ?? 'FA'}
                {g && (g.state === 'pre' ? ` · ${fmtDay(g.start)} ${fmtTime(g.start)}` : g.state === 'in' ? ` · ${g.statusText}${hasBall ? ' · 🏈' : ''}` : ' · Final')}
              </small>
            </div>
            {m && <button className="icon" title={`Watch on ${m.channel.name}`} onClick={() => { tune(m.channel.id); navigate('watch'); }}><Play /></button>}
            <b className="pts">{pts != null ? pts.toFixed(1) : '—'}</b>
          </div>
        );
      })}
    </div>
  );
}

export default function FantasyPage() {
  const cfg = useApp((s) => s.fantasy);
  const set = useApp((s) => s.set);
  const channels = useApp((s) => s.channels);
  const overrides = useApp((s) => s.networkOverrides);
  const { matchup, loading, error, week, updated, refresh, leagues } = useFantasy();
  const ranked = useRankedGames((g) => g.league === 'nfl' && g.state !== 'post');
  const withStakes = useMemo(() => ranked.filter((r) => r.stakes), [ranked]);

  if (!cfg?.leagueId) return <Connect />;

  const fillMultiview = () => {
    const ids: (string | null)[] = [];
    for (const r of withStakes.filter((x) => x.g.state === 'in')) {
      const m = matchBroadcasts(r.g.broadcasts, channels, overrides);
      if (m && !ids.includes(m.channel.id)) ids.push(m.channel.id);
      if (ids.length === 4) break;
    }
    while (ids.length < 4) ids.push(null);
    set({ multiview: ids });
    navigate('multiview');
  };

  const me = matchup?.me;
  const opp = matchup?.opponent;
  const diff = me && opp ? me.points - opp.points : 0;

  return (
    <div className="fantasyPage">
      <div className="guideBar">
        <div className="chips">
          {leagues.length > 1 ? (
            <select className="field small" value={cfg.leagueId} onChange={(e) => {
              const l = leagues.find((x) => x.id === e.target.value);
              if (l) { set({ fantasy: { ...cfg, leagueId: l.id, leagueName: l.name } }); useFantasy.setState({ matchup: undefined }); setTimeout(() => void refresh(), 0); }
            }}>
              {leagues.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          ) : <b>{cfg.leagueName}</b>}
          <span className="muted">Week {week ?? '…'} · {cfg.displayName}</span>
        </div>
        <div className="chips">
          <button onClick={fillMultiview} disabled={!withStakes.some((r) => r.g.state === 'in')}><Grid2x2 /> Multiview my games</button>
          <button onClick={() => void refresh()}>{loading ? <Loader2 className="spin" /> : <RefreshCw />}</button>
          <button onClick={() => { set({ fantasy: undefined }); useFantasy.setState({ matchup: undefined, leagues: [] }); }} title="Disconnect"><LogOut /></button>
        </div>
      </div>
      {error && <div className="banner warn">{error}</div>}
      {!matchup ? (
        <Empty title="Loading matchup…" />
      ) : (
        <>
          <div className="matchHead">
            <div className={diff >= 0 ? 'win' : ''}><small>{me!.ownerName}</small><h2>{me!.teamName}</h2><b>{me!.points.toFixed(2)}</b></div>
            <div className="vs">{opp ? (diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1)) : 'BYE'}</div>
            <div className={diff < 0 ? 'win' : ''}><small>{opp?.ownerName ?? ''}</small><h2>{opp?.teamName ?? '—'}</h2><b>{opp?.points.toFixed(2) ?? '—'}</b></div>
          </div>
          <div className="rosters">
            <Roster team={me!} side="me" />
            {opp && <Roster team={opp} side="opp" />}
          </div>
          <h3 className="sectionTitle">WHERE YOUR MATCHUP IS DECIDED</h3>
          {withStakes.length ? (
            <div className="gameGrid">{withStakes.map((r) => <GameCard key={r.g.id} g={r.g} stakes={r.stakes} />)}</div>
          ) : <p className="muted">No remaining games with starters from either team this week.</p>}
          <p className="muted small">Live points from Sleeper{updated ? ` · updated ${new Date(updated).toLocaleTimeString()}` : ''}. Refreshes every minute while NFL games are live.</p>
        </>
      )}
    </div>
  );
}
