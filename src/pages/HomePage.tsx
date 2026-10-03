import { useEffect, useState } from 'react';
import { CalendarClock, Flame, Gamepad2, Play, Star, Ticket, Trophy } from 'lucide-react';
import { useApp } from '../store/app';
import { useFantasy } from '../store/fantasy';
import { onBreak, useBets } from '../store/bets';
import { useRankedGames } from '../hooks/useSports';
import { GameCard, useGameChannel } from '../components/GameCard';
import { Empty, TeamLogo, countdown, fmtDay, fmtTime } from '../components/ui';
import { navigate } from '../app/router';
import { betProfit, fmtMoney, leagueLabel, legLabel, potentialReturn } from '../lib/sports';
import { startOfDay } from '../lib/scheduler';
import type { SportEvent } from '../types';
import { TeamPicker } from '../components/TeamPicker';
import { TonightPlan } from '../components/sports/SmartPlan';
import { bookInfo } from '../providers/oddsapi';

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function NextUp({ g }: { g: SportEvent }) {
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
        {g.state === 'in' ? <span className="liveDot">LIVE NOW</span> : <><small>STARTS IN</small><b>{countdown(g.start)}</b></>}
        {m && <button className="watchBtn" onClick={() => { tune(m.channel.id); navigate('watch'); }}><Play /> {m.channel.name}</button>}
      </div>
    </div>
  );
}

function FantasyPanel() {
  const cfg = useApp((s) => s.fantasy);
  const matchup = useFantasy((s) => s.matchup);
  const error = useFantasy((s) => s.error);
  return (
    <div className="panel">
      <h3 className="sectionTitle"><Gamepad2 /> FANTASY {cfg && <small className="muted">{cfg.provider === 'espn' ? 'ESPN' : 'Sleeper'}</small>}</h3>
      {!cfg?.leagueId ? (
        <p className="muted">Connect Sleeper or ESPN to see who to root for. <button className="link" onClick={() => navigate('fantasy')}>Connect</button></p>
      ) : matchup ? (
        <div className="miniMatch" onClick={() => navigate('fantasy')} role="button" tabIndex={0}>
          <div><small>{matchup.me.teamName}</small><b>{matchup.me.points.toFixed(2)}</b></div>
          <span>vs</span>
          <div><small>{matchup.opponent?.teamName ?? 'Bye'}</small><b>{matchup.opponent?.points.toFixed(2) ?? '—'}</b></div>
        </div>
      ) : error ? <p className="err small">{error}</p> : (
        <p className="muted">{cfg.provider === 'espn' && !cfg.userId ? 'Pick your team' : 'Loading matchup…'} <button className="link" onClick={() => navigate('fantasy')}>Open</button></p>
      )}
    </div>
  );
}

function BetsPanel() {
  const bets = useBets((s) => s.bets);
  const breakUntil = useBets((s) => s.breakUntil);
  if (onBreak({ breakUntil })) return null;
  const open = bets.filter((b) => b.status === 'open');
  const today = startOfDay(Date.now());
  const todayPL = bets.filter((b) => b.status !== 'open' && (b.settledAt ?? 0) >= today).reduce((a, b) => a + betProfit(b), 0);
  return (
    <div className="panel">
      <h3 className="sectionTitle"><Ticket /> BETS <button className="link" onClick={() => navigate('bets')}>Odds &amp; tracker</button></h3>
      <div className="betSnap">
        <div><small>Open</small><b>{open.length}</b><em>{fmtMoney(open.reduce((a, b) => a + b.stake, 0))} staked</em></div>
        <div><small>Today</small><b className={todayPL > 0 ? 'up' : todayPL < 0 ? 'down' : ''}>{fmtMoney(todayPL, true)}</b><em>settled P/L</em></div>
      </div>
      {open.slice(0, 3).map((b) => (
        <div className="tonightRow" key={b.id}>
          <time>{bookInfo(b.book).title}</time>
          <div><b>{b.type === 'parlay' ? `${b.legs.length}-leg parlay` : legLabel(b.legs[0])}</b><small>to win {fmtMoney(potentialReturn(b) - b.stake)}</small></div>
        </div>
      ))}
    </div>
  );
}

export default function HomePage() {
  const favTeams = useApp((s) => s.favTeams);
  const sportsError = useApp((s) => s.sportsError);
  const [picking, setPicking] = useState(false);

  const live = useRankedGames((g) => g.state === 'in');
  const favUpcoming = useRankedGames((g) => g.state !== 'post' && (favTeams.includes(`${g.league}:${g.home.abbr}`) || favTeams.includes(`${g.league}:${g.away.abbr}`)))
    .map((r) => r.g)
    .sort((a, b) => (a.state === 'in' ? -1 : 0) - (b.state === 'in' ? -1 : 0) || a.start - b.start);

  const best = live[0];

  return (
    <div className="home">
      {sportsError && <div className="banner warn">{sportsError}</div>}

      <section>
        <h3 className="sectionTitle"><Star /> YOUR TEAMS <button className="link" onClick={() => navigate('teams')}>My Teams</button><button className="link" onClick={() => setPicking(true)}>Edit teams</button></h3>
        {favTeams.length === 0 ? (
          <Empty icon={<Trophy />} title="Pick your teams">
            Choose favorite teams for countdowns, a My Teams page, priority alerts and smart scheduling.{' '}
            <button className="primary" onClick={() => setPicking(true)}>Choose teams</button>
          </Empty>
        ) : favUpcoming.length ? (
          <div className="nextUps">{favUpcoming.slice(0, 3).map((g) => <NextUp key={g.id} g={g} />)}</div>
        ) : (
          <p className="muted">No games for your teams in the next week. <button className="link" onClick={() => navigate('teams')}>See full schedules</button></p>
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
            <Empty title="Nothing live right now">Clutch alerts will light up when games start.</Empty>
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
            <h3 className="sectionTitle"><CalendarClock /> TONIGHT’S PLAN <button className="link" onClick={() => navigate('schedule', 'smart')}>Smart Schedule</button></h3>
            <TonightPlan />
          </div>
          <FantasyPanel />
          <BetsPanel />
        </section>
      </div>
      {picking && <TeamPicker onClose={() => setPicking(false)} />}
    </div>
  );
}
