import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Flame, Gamepad2, Play, Star, Ticket, Trophy } from 'lucide-react';
import { useApp } from '../store/app';
import { useFantasy } from '../store/fantasy';
import { useRankedGames } from '../hooks/useSports';
import { GameCard, useGameChannel } from '../components/GameCard';
import { Empty, TeamLogo, countdown, fmtDay, fmtTime } from '../components/ui';
import { navigate } from '../app/router';
import { leagueLabel } from '../lib/sports';
import { startOfDay, HOUR } from '../lib/scheduler';
import type { SportEvent } from '../types';
import { TeamPicker } from '../components/TeamPicker';

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function NextUp({ g }: { g: SportEvent }) {
  useTick(1000);
  const tune = useApp((s) => s.tune);
  const m = useGameChannel(g);
  return (
    <div className="nextUp" style={{ ['--home' as string]: g.home.color ?? '#333', ['--away' as string]: g.away.color ?? '#333' }}>
      <div className="nuTeams">
        <TeamLogo team={g.away} size={56} />
        <div>
          <small>{leagueLabel(g.league)} · {fmtDay(g.start)} {fmtTime(g.start)}</small>
          <h2>{g.away.shortName} <i>at</i> {g.home.shortName}</h2>
          <p>{g.broadcasts.join(' · ') || 'Broadcast TBD'}{g.odds?.details ? ` · ${g.odds.details}` : ''}</p>
        </div>
        <TeamLogo team={g.home} size={56} />
      </div>
      <div className="nuCount">
        {g.state === 'in' ? <span className="liveDot">LIVE NOW</span> : <><small>KICKOFF IN</small><b>{countdown(g.start)}</b></>}
        {m && <button className="watchBtn" onClick={() => { tune(m.channel.id); navigate('watch'); }}><Play /> {m.channel.name}</button>}
      </div>
    </div>
  );
}

export default function HomePage() {
  const favTeams = useApp((s) => s.favTeams);
  const schedule = useApp((s) => s.schedule);
  const picks = useApp((s) => s.picks);
  const sportsError = useApp((s) => s.sportsError);
  const fantasyCfg = useApp((s) => s.fantasy);
  const matchup = useFantasy((s) => s.matchup);
  const [picking, setPicking] = useState(false);

  const live = useRankedGames((g) => g.state === 'in');
  const favUpcoming = useRankedGames((g) => g.state !== 'post' && (favTeams.includes(`${g.league}:${g.home.abbr}`) || favTeams.includes(`${g.league}:${g.away.abbr}`)))
    .map((r) => r.g)
    .sort((a, b) => (a.state === 'in' ? -1 : 0) - (b.state === 'in' ? -1 : 0) || a.start - b.start);

  const tonight = useMemo(() => {
    const end = startOfDay(Date.now()) + 30 * HOUR;
    return schedule.filter((e) => e.end > Date.now() && e.start < end).sort((a, b) => a.start - b.start);
  }, [schedule]);

  const best = live[0];
  const pending = picks.filter((p) => !p.result).length;

  return (
    <div className="home">
      {sportsError && <div className="banner warn">{sportsError}</div>}

      <section>
        <h3 className="sectionTitle"><Star /> YOUR TEAMS <button className="link" onClick={() => setPicking(true)}>Edit teams</button></h3>
        {favTeams.length === 0 ? (
          <Empty icon={<Trophy />} title="Pick your teams">
            Choose favorite teams for countdowns, auto-schedule rules and priority alerts.{' '}
            <button className="primary" onClick={() => setPicking(true)}>Choose teams</button>
          </Empty>
        ) : favUpcoming.length ? (
          <div className="nextUps">{favUpcoming.slice(0, 3).map((g) => <NextUp key={g.id} g={g} />)}</div>
        ) : (
          <p className="muted">No upcoming games for your teams in the next week.</p>
        )}
      </section>

      <div className="homeGrid">
        <section>
          <h3 className="sectionTitle"><Flame /> BEST GAME RIGHT NOW</h3>
          {best ? (
            <div className="bestGame">
              <div className="reasons">{best.reasons.length ? best.reasons.map((r) => <span key={r}>{r}</span>) : <span>Live</span>}</div>
              <GameCard g={best.g} stakes={best.stakes} />
            </div>
          ) : (
            <Empty title="Nothing live right now">The ticker and alerts will light up when games start.</Empty>
          )}
          {live.length > 1 && (
            <>
              <h3 className="sectionTitle">ALSO LIVE · RANKED BY WATCHABILITY</h3>
              <div className="gameGrid">{live.slice(1, 7).map((r) => <GameCard key={r.g.id} g={r.g} stakes={r.stakes} compact />)}</div>
            </>
          )}
        </section>

        <section className="side">
          <div className="panel">
            <h3 className="sectionTitle"><CalendarClock /> TONIGHT <button className="link" onClick={() => navigate('schedule')}>Open planner</button></h3>
            {tonight.length ? tonight.map((e) => (
              <div className="tonightRow" key={e.id}>
                <time>{fmtTime(e.start)}</time>
                <div><b>{e.title}</b><small>{e.notes}</small></div>
              </div>
            )) : <p className="muted">Nothing scheduled. Add games from Sports or shows from the Guide.</p>}
          </div>

          <div className="panel">
            <h3 className="sectionTitle"><Gamepad2 /> FANTASY</h3>
            {!fantasyCfg ? (
              <p className="muted">Connect your Sleeper league to see who to root for. <button className="link" onClick={() => navigate('fantasy')}>Connect</button></p>
            ) : matchup ? (
              <div className="miniMatch" onClick={() => navigate('fantasy')}>
                <div><small>{matchup.me.teamName}</small><b>{matchup.me.points.toFixed(2)}</b></div>
                <span>vs</span>
                <div><small>{matchup.opponent?.teamName ?? 'Bye'}</small><b>{matchup.opponent?.points.toFixed(2) ?? '—'}</b></div>
              </div>
            ) : <p className="muted">Loading matchup… <button className="link" onClick={() => navigate('fantasy')}>Open</button></p>}
          </div>

          <div className="panel">
            <h3 className="sectionTitle"><Ticket /> PICK’EM</h3>
            <p className="muted">{pending ? `${pending} pick${pending > 1 ? 's' : ''} riding.` : 'No open picks.'} <button className="link" onClick={() => navigate('bets')}>Open Bets</button></p>
          </div>
        </section>
      </div>
      {picking && <TeamPicker onClose={() => setPicking(false)} />}
    </div>
  );
}
