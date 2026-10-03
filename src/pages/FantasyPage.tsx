import { useMemo, useState } from 'react';
import { Gamepad2, Grid2x2, Lightbulb, Loader2, LogOut, Play, RefreshCw } from 'lucide-react';
import { useApp, type FantasyConfig } from '../store/app';
import { useShallow } from 'zustand/react/shallow';
import { startSitHints, useFantasy } from '../store/fantasy';
import { sleeperProvider } from '../providers/sleeper';
import { espnSeason, espnSnapshot } from '../providers/espnFantasy';
import type { FantasyLeague, FantasyPlayer, FantasySnapshot, FantasyTeam } from '../providers/types';
import { useRankedGames } from '../hooks/useSports';
import { GameCard } from '../components/GameCard';
import { Empty, fmtDay, fmtTime } from '../components/ui';
import { matchBroadcasts } from '../lib/channelMatch';
import { navigate } from '../app/router';
import type { SportEvent } from '../types';

function connect(cfg: FantasyConfig, extra: Partial<ReturnType<typeof useFantasy.getState>> = {}) {
  useApp.getState().set({ fantasy: cfg });
  useFantasy.setState({ matchup: undefined, error: undefined, ...extra });
  loadLeague(cfg.leagueId ?? '');
}

function SleeperConnect() {
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

  return (
    <>
      <p className="muted">Read-only and public — just your Sleeper username. No password, nothing is posted.</p>
      {!leagues ? (
        <form onSubmit={lookup} className="row">
          <input className="field" autoFocus placeholder="Sleeper username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <button className="primary" disabled={!username || busy}>{busy ? <Loader2 className="spin" /> : 'Find leagues'}</button>
        </form>
      ) : (
        <div className="col">
          <p>Pick a league for <b>{user?.displayName}</b>:</p>
          {leagues.map((l) => (
            <button key={l.id} className="leagueBtn" onClick={() => connect({ provider: 'sleeper', username, userId: user!.userId, displayName: user!.displayName, leagueId: l.id, leagueName: l.name }, { leagues })}>
              {l.avatar && <img src={l.avatar} alt="" width={28} height={28} />}{l.name}<small>{l.season}</small>
            </button>
          ))}
          <button className="ghost" onClick={() => setLeagues(undefined)}>Back</button>
        </div>
      )}
      {err && <p className="err">{err}</p>}
    </>
  );
}

/** Accepts a bare id or a pasted league URL (…?leagueId=123456). */
export const parseEspnLeagueId = (raw: string) => raw.match(/leagueId=(\d+)/i)?.[1] ?? raw.trim();

function EspnTeamChoice({ snap, leagueId, season }: { snap: Pick<FantasySnapshot, 'teams' | 'league'>; leagueId: string; season: string }) {
  return (
    <div className="col">
      <p>Which team is yours in <b>{snap.league.name}</b>?</p>
      {snap.teams.map((t) => (
        <button key={t.id} className="leagueBtn" onClick={() => connect({ provider: 'espn', username: '', userId: t.id, displayName: t.name, leagueId, leagueName: snap.league.name, season }, { teams: snap.teams })}>
          {t.name}<small>{t.owner}</small>
        </button>
      ))}
    </div>
  );
}

function EspnConnect() {
  const [raw, setRaw] = useState('');
  const [season, setSeason] = useState(espnSeason());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [snap, setSnap] = useState<FantasySnapshot>();
  const id = parseEspnLeagueId(raw);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    try {
      setSnap(await espnSnapshot(id, season));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (snap) return <><EspnTeamChoice snap={snap} leagueId={id} season={season} /><button className="ghost" onClick={() => setSnap(undefined)}>Back</button></>;
  return (
    <>
      <p className="muted">Paste your ESPN league link or id (fantasy.espn.com/football/league?leagueId=<b>123456</b>). Read-only; no ESPN login.</p>
      <form onSubmit={lookup} className="row">
        <input className="field" autoFocus aria-label="ESPN league id" placeholder="League id or link" value={raw} onChange={(e) => setRaw(e.target.value)} />
        <input className="field small" aria-label="Season" value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, '').slice(0, 4))} style={{ flex: '0 0 80px' }} />
        <button className="primary" disabled={!/^\d+$/.test(id) || busy}>{busy ? <Loader2 className="spin" /> : 'Find league'}</button>
      </form>
      <p className="small muted">Private leagues: ESPN only shares them with a logged-in ESPN session, which Dial TV can’t use. The commissioner can turn on “Make League Viewable to Public” (League → Settings → Basic Settings); then it works here.</p>
      {err && <p className="err">{err}</p>}
    </>
  );
}

function Connect() {
  const [platform, setPlatform] = useState<'sleeper' | 'espn'>('sleeper');
  return (
    <div className="connect panel">
      <Gamepad2 className="big" />
      <h2>Connect your fantasy league</h2>
      <p className="muted">Live matchup board, red-zone alerts for your starters, start/sit hints, and games ranked by how much they matter to your matchup.</p>
      <div className="chips" role="tablist" aria-label="Platform">
        <button role="tab" aria-selected={platform === 'sleeper'} className={platform === 'sleeper' ? 'on' : ''} onClick={() => setPlatform('sleeper')}>Sleeper</button>
        <button role="tab" aria-selected={platform === 'espn'} className={platform === 'espn' ? 'on' : ''} onClick={() => setPlatform('espn')}>ESPN</button>
      </div>
      {platform === 'sleeper' ? <SleeperConnect /> : <EspnConnect />}
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
  const proj = team.playerProjections;
  return (
    <div className={`roster ${side}`}>
      <div className="rosterHead"><b>{team.teamName}</b>{team.projected != null && <small>proj {team.projected.toFixed(1)}</small>}</div>
      {team.starters.map((id) => {
        const p = players[id] ?? { id, name: id, position: '?' };
        const g = playerGame(p, list);
        const pts = team.playerPoints[id];
        const pos = g?.situation?.possessionTeamId;
        const hasBall = g && pos && (g.home.abbr === p.team ? g.home.id : g.away.id) === pos;
        const rz = hasBall && g?.situation?.isRedZone;
        const m = g && g.state === 'in' ? matchBroadcasts(g.broadcasts, channels, overrides) : null;
        const pr = proj?.[id];
        return (
          <div key={id} className={`rp ${rz ? 'rz' : ''} ${g?.state ?? ''}`}>
            <span className="pos">{team.slots?.[id] ?? p.position}</span>
            <div className="pn">
              <b>{p.name}{p.injury && <em className="inj">{p.injury[0]}</em>}</b>
              <small>
                {p.team ?? 'FA'}
                {g && (g.state === 'pre' ? ` · ${fmtDay(g.start)} ${fmtTime(g.start)}` : g.state === 'in' ? ` · ${g.statusText}${hasBall ? ' · ball' : ''}${rz ? ' · RED ZONE' : ''}` : ' · Final')}
                {pr != null && ` · proj ${pr.toFixed(1)}`}
              </small>
            </div>
            {m && <button className="icon" title={`Watch on ${m.channel.name}`} onClick={() => { tune(m.channel.id); navigate('watch'); }}><Play /></button>}
            <b className={`pts ${pr != null && pts != null && g?.state === 'post' ? (pts >= pr ? 'up' : 'down') : ''}`}>{pts != null ? pts.toFixed(1) : '—'}</b>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Load a newly selected league. If a refresh for the previous league is still in flight,
 * drop its result and refresh again once it lands, so the old league never shows.
 */
function loadLeague(leagueId: string) {
  const f = useFantasy.getState();
  useFantasy.setState({ matchup: undefined });
  if (!f.loading) { void f.refresh(); return; }
  const unsub = useFantasy.subscribe((st, prev) => {
    if (!prev.loading || st.loading) return;
    unsub();
    if (useApp.getState().fantasy?.leagueId !== leagueId) return;
    useFantasy.setState({ matchup: undefined });
    void st.refresh();
  });
}

export default function FantasyPage() {
  const cfg = useApp((s) => s.fantasy);
  const set = useApp((s) => s.set);
  const channels = useApp((s) => s.channels);
  const overrides = useApp((s) => s.networkOverrides);
  const games = useApp((s) => s.games);
  const { matchup, loading, error, week, updated, refresh, leagues, teams, players } = useFantasy(useShallow((s) => ({ matchup: s.matchup, loading: s.loading, error: s.error, week: s.week, updated: s.updated, refresh: s.refresh, leagues: s.leagues, teams: s.teams, players: s.players })));
  const ranked = useRankedGames((g) => g.league === 'nfl' && g.state !== 'post');
  const withStakes = useMemo(() => ranked.filter((r) => r.stakes), [ranked]);
  const hints = useMemo(() => {
    const list = Object.values(games);
    return startSitHints(matchup, players, (team) => {
      const g = team ? list.find((x) => x.league === 'nfl' && (x.home.abbr === team || x.away.abbr === team) && x.start > Date.now() - 5 * 86400e3 && x.start < Date.now() + 6 * 86400e3) : undefined;
      return !g || g.state === 'pre';
    });
  }, [matchup, players, games]);

  if (!cfg?.leagueId) return <Connect />;
  const espn = cfg.provider === 'espn';
  if (espn && !cfg.userId) {
    return <div className="connect panel">{teams.length ? <EspnTeamChoice snap={{ teams, league: { id: cfg.leagueId, name: cfg.leagueName ?? '', season: cfg.season ?? '' } }} leagueId={cfg.leagueId} season={cfg.season ?? espnSeason()} /> : <Loader2 className="spin" />}</div>;
  }

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
  const disconnect = () => { set({ fantasy: undefined }); useFantasy.setState({ matchup: undefined, leagues: [], teams: [], error: undefined }); };

  return (
    <div className="fantasyPage">
      <div className="guideBar">
        <div className="chips">
          <span className="platformTag">{espn ? 'ESPN' : 'Sleeper'}</span>
          {!espn && leagues.length > 1 ? (
            <select className="field small" value={cfg.leagueId} onChange={(e) => {
              const l = leagues.find((x) => x.id === e.target.value);
              if (l) { set({ fantasy: { ...cfg, leagueId: l.id, leagueName: l.name } }); loadLeague(l.id); }
            }}>
              {leagues.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          ) : <b>{cfg.leagueName}</b>}
          {espn && teams.length > 1 && (
            <select className="field small" aria-label="My team" value={cfg.userId} onChange={(e) => {
              const t = teams.find((x) => x.id === e.target.value);
              if (t) { set({ fantasy: { ...cfg, userId: t.id, displayName: t.name } }); loadLeague(cfg.leagueId!); }
            }}>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <span className="muted">Week {week ?? '…'}{!espn ? ` · ${cfg.displayName}` : ''}</span>
        </div>
        <div className="chips">
          <button onClick={fillMultiview} disabled={!withStakes.some((r) => r.g.state === 'in')}><Grid2x2 /> Multiview my games</button>
          <button onClick={() => void refresh()} aria-label="Refresh">{loading ? <Loader2 className="spin" /> : <RefreshCw />}</button>
          <button onClick={disconnect} title="Disconnect" aria-label="Disconnect"><LogOut /></button>
        </div>
      </div>
      {error && <div className="banner warn">{error}</div>}
      {!matchup ? (
        error ? null : <Empty title={`Loading ${cfg.leagueName ?? 'matchup'}…`} />
      ) : (
        <>
          <div className="matchHead">
            <div className={diff >= 0 ? 'win' : ''}><small>{me!.ownerName}</small><h2>{me!.teamName}</h2><b>{me!.points.toFixed(2)}</b>{me!.projected != null && <small>proj {me!.projected.toFixed(1)}</small>}</div>
            <div className="vs">{opp ? (diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1)) : 'BYE'}</div>
            <div className={diff < 0 ? 'win' : ''}><small>{opp?.ownerName ?? ''}</small><h2>{opp?.teamName ?? '—'}</h2><b>{opp?.points.toFixed(2) ?? '—'}</b>{opp?.projected != null && <small>proj {opp.projected.toFixed(1)}</small>}</div>
          </div>
          {hints.length > 0 && (
            <div className="panel hints">
              <h3 className="sectionTitle"><Lightbulb /> START / SIT</h3>
              {hints.map((h) => (
                <p key={h.benchId}>Consider starting <b>{players[h.benchId]?.name}</b> over <b>{players[h.starterId]?.name}</b> <span className="muted">(+{h.gain} projected)</span></p>
              ))}
              <p className="muted small">From {espn ? 'ESPN' : 'platform'} projections, only for players whose games haven’t started. Lineup changes are made in the {espn ? 'ESPN' : 'Sleeper'} app.</p>
            </div>
          )}
          <div className="rosters">
            <Roster team={me!} side="me" />
            {opp && <Roster team={opp} side="opp" />}
          </div>
          <h3 className="sectionTitle">WHERE YOUR MATCHUP IS DECIDED</h3>
          {withStakes.length ? (
            <div className="gameGrid">{withStakes.map((r) => <GameCard key={r.g.id} g={r.g} stakes={r.stakes} />)}</div>
          ) : <p className="muted">No remaining games with starters from either team this week.</p>}
          <p className="muted small">Live points from {espn ? 'ESPN Fantasy' : 'Sleeper'}{updated ? ` · updated ${new Date(updated).toLocaleTimeString()}` : ''}. Refreshes every minute while NFL games are live. Red-zone alerts fire when one of your starters’ teams drives inside the 20.</p>
        </>
      )}
    </div>
  );
}
