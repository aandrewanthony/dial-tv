import { useEffect, useState } from 'react';
import { CalendarPlus, Check, Loader2, Play, Shield, Star, Trash2 } from 'lucide-react';
import { useApp } from '../store/app';
import { leagueTeams, teamSchedule, type TeamSchedule } from '../providers/espn';
import { leagueLabel } from '../lib/sports';
import { entryFromGame } from '../lib/scheduler';
import { matchBroadcasts } from '../lib/channelMatch';
import { Empty, TeamLogo, countdown, fmtDay, fmtTime, useNow } from '../components/ui';
import { TeamPicker, setTeamRule, toggleFavTeam } from '../components/TeamPicker';
import { navigate } from '../app/router';
import type { League, SportEvent } from '../types';

function useTeamSchedule(key: string) {
  const [league, abbr] = key.split(':') as [League, string];
  const [data, setData] = useState<TeamSchedule>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let live = true;
    setErr(undefined);
    leagueTeams(league)
      .then((ts) => {
        const t = ts.find((x) => x.abbr === abbr);
        if (!t) throw new Error(`${abbr} not found in ${leagueLabel(league)}`);
        return teamSchedule(league, t.id);
      })
      .then((d) => live && setData(d), (e) => live && setErr(String((e as Error).message ?? e)));
    return () => { live = false; };
  }, [league, abbr]);
  return { league, abbr, data, err };
}

function resultFor(g: SportEvent, abbr: string) {
  const home = g.home.abbr === abbr;
  const mine = home ? g.homeScore : g.awayScore;
  const theirs = home ? g.awayScore : g.homeScore;
  if (mine == null || theirs == null) return '';
  return mine > theirs ? 'W' : mine < theirs ? 'L' : 'T';
}

function TeamCard({ k }: { k: string }) {
  useNow(1000);
  const { league, abbr, data, err } = useTeamSchedule(k);
  const games = useApp((s) => s.games);
  const channels = useApp((s) => s.channels);
  const overrides = useApp((s) => s.networkOverrides);
  const schedule = useApp((s) => s.schedule);
  const rule = useApp((s) => s.rules.some((r) => r.kind === 'team' && r.match === k));
  const update = useApp((s) => s.update);
  const tune = useApp((s) => s.tune);
  // Prefer the live scoreboard copy of a game (fresher score/status/broadcasts).
  const events = (data?.events ?? []).map((e) => games[e.id] ?? e);
  const now = Date.now();
  const next = events.find((e) => e.state === 'in') ?? events.find((e) => e.state === 'pre' && e.start > now - 4 * 3600e3 && !e.postponed);
  const upcoming = events.filter((e) => e.state === 'pre' && e !== next).slice(0, 5);
  const recent = events.filter((e) => e.state === 'post').slice(-4).reverse();
  const m = next ? matchBroadcasts(next.broadcasts, channels, overrides) : null;
  const team = data?.team;
  const opp = (g: SportEvent) => (g.home.abbr === abbr ? `vs ${g.away.shortName}` : `@ ${g.home.shortName}`);
  const scheduled = (g: SportEvent) => schedule.some((e) => e.eventId === g.id);

  return (
    <div className="teamCard" style={{ ['--team' as string]: team?.color ?? '#333' }}>
      <div className="tcHead">
        {team ? <TeamLogo team={team} size={48} /> : <span className="teamLogo mark" style={{ width: 48, height: 48 }}>{abbr}</span>}
        <div>
          <h2>{team?.name ?? abbr}</h2>
          <small>{leagueLabel(league)}{team?.record ? ` · ${team.record}` : ''}{team?.standing ? ` · ${team.standing}` : ''}</small>
        </div>
        <span className="spacer" />
        <button className={`icon ${rule ? 'on' : ''}`} title={rule ? 'Every game is auto-scheduled' : 'Add every game to my schedule'} aria-label={rule ? 'Stop auto-scheduling' : 'Add every game to my schedule'} onClick={() => setTeamRule(k, !rule)}>{rule ? <Check /> : <CalendarPlus />}</button>
        <button className="icon" aria-label={`Remove ${abbr}`} title="Remove from my teams" onClick={() => toggleFavTeam(k)}><Trash2 /></button>
      </div>
      {err && <p className="err small">{err}</p>}
      {!data && !err && <p className="muted"><Loader2 className="spin" /> Loading schedule…</p>}
      {data && (
        <>
          <div className="tcNext">
            {next ? (
              <>
                <div>
                  <small>{next.state === 'in' ? 'LIVE NOW' : 'NEXT GAME'}</small>
                  <b>{opp(next)}</b>
                  <span className="muted small">{next.state === 'in' ? `${next.away.abbr} ${next.awayScore} – ${next.home.abbr} ${next.homeScore} · ${next.statusText}` : `${fmtDay(next.start)} ${fmtTime(next.start)}`} · {next.broadcasts.join(', ') || 'TV TBD'}</span>
                </div>
                {next.state === 'pre' && <b className="tcCount" aria-label="Countdown">{countdown(next.start)}</b>}
                <div className="col">
                  {m ? <button className="watchBtn" onClick={() => { tune(m.channel.id); navigate('watch'); }}><Play /> {m.channel.name}</button> : <button className="ghost small" onClick={() => navigate('settings', 'mapping')}>Map channel</button>}
                  {!scheduled(next) && <button className="ghost small" onClick={() => update((s) => ({ schedule: [...s.schedule, entryFromGame(next, undefined, 15)] }))}><CalendarPlus /> Schedule</button>}
                </div>
              </>
            ) : <span className="muted">No upcoming games{data.byeWeek ? ` · bye in week ${data.byeWeek}` : ''}.</span>}
          </div>
          <div className="tcCols">
            <div>
              <h4>RECENT</h4>
              {recent.length ? recent.map((g) => (
                <div className="tcRow" key={g.id}><span className={`res ${resultFor(g, abbr)}`}>{resultFor(g, abbr)}</span><span>{opp(g)}</span><span className="mono">{g.home.abbr === abbr ? `${g.homeScore}-${g.awayScore}` : `${g.awayScore}-${g.homeScore}`}</span></div>
              )) : <p className="muted small">No results yet this season.</p>}
            </div>
            <div>
              <h4>UPCOMING</h4>
              {upcoming.length ? upcoming.map((g) => (
                <div className="tcRow" key={g.id}><span className="mono">{fmtDay(g.start)}</span><span>{opp(g)}</span><span className="muted">{fmtTime(g.start)} · {g.broadcasts[0] ?? 'TBD'}</span></div>
              )) : <p className="muted small">Nothing else scheduled yet.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function TeamsPage() {
  const favTeams = useApp((s) => s.favTeams);
  const [picking, setPicking] = useState(false);
  return (
    <div className="teamsPage">
      <div className="guideBar">
        <div className="chips"><span className="muted">{favTeams.length} team{favTeams.length === 1 ? '' : 's'}</span></div>
        <div className="chips"><button onClick={() => setPicking(true)}><Star /> Edit teams</button></div>
      </div>
      {!favTeams.length ? (
        <Empty icon={<Shield />} title="No teams yet">Follow your teams for countdowns, results, standings and one-click watching. <button className="primary" onClick={() => setPicking(true)}>Choose teams</button></Empty>
      ) : (
        <div className="teamCards">{favTeams.map((k) => <TeamCard key={k} k={k} />)}</div>
      )}
      <p className="muted small">Schedules, records and standings from ESPN. Channels come from your playlist (Settings → mapping).</p>
      {picking && <TeamPicker onClose={() => setPicking(false)} />}
    </div>
  );
}
