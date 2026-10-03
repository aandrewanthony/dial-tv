import { CalendarPlus, Check, Eye, Flame, Play, Star, Tv } from 'lucide-react';
import type { SportEvent } from '../types';
import { useApp, showScore } from '../store/app';
import { matchBroadcasts } from '../lib/channelMatch';
import { clutchInfo, fmtLine, leagueLabel, spreadFor } from '../lib/sports';
import { entryFromGame } from '../lib/scheduler';
import { TeamLogo, fmtDay, fmtTime } from './ui';
import type { GameStakes } from '../store/fantasy';
import { navigate } from '../app/router';

export function useGameChannel(g: SportEvent) {
  const channels = useApp((s) => s.channels);
  const overrides = useApp((s) => s.networkOverrides);
  return matchBroadcasts(g.broadcasts, channels, overrides);
}

export function GameCard({ g, stakes, compact }: { g: SportEvent; stakes?: GameStakes; compact?: boolean }) {
  const app = useApp();
  const match = useGameChannel(g);
  const visible = showScore(app, g.id);
  const clutch = clutchInfo(g);
  const scheduled = app.schedule.some((e) => e.eventId === g.id);
  const favHome = app.favTeams.includes(`${g.league}:${g.home.abbr}`);
  const favAway = app.favTeams.includes(`${g.league}:${g.away.abbr}`);
  const possession = g.situation?.possessionTeamId;

  const watch = () => {
    if (!match) return;
    app.tune(match.channel.id);
    navigate('watch');
  };
  const toggleSchedule = () => {
    const e = entryFromGame(g, undefined, 10);
    app.update((s) => ({ schedule: scheduled ? s.schedule.filter((x) => x.eventId !== g.id) : [...s.schedule, e] }));
  };

  const row = (side: 'away' | 'home') => {
    const t = g[side];
    const score = side === 'home' ? g.homeScore : g.awayScore;
    const other = side === 'home' ? g.awayScore : g.homeScore;
    const winning = g.state !== 'pre' && score != null && other != null && score > other;
    const fav = side === 'home' ? favHome : favAway;
    return (
      <div className={`teamRow ${winning && visible ? 'lead' : ''} ${g.state === 'post' && !winning && visible ? 'lost' : ''}`}>
        <TeamLogo team={t} />
        <span className="tname">{t.shortName}{fav && <Star className="favStar" />}{possession === t.id && <span className="poss" title="Possession">●</span>}</span>
        <small>{t.record}</small>
        <b className="score">{g.state === 'pre' ? '' : visible ? score : '•'}</b>
      </div>
    );
  };

  return (
    <div className={`gameCard ${g.state} ${clutch.clutch ? 'clutch' : ''} ${compact ? 'compact' : ''}`}>
      <div className="gcHead">
        <span className="lg">{leagueLabel(g.league)}</span>
        {g.state === 'in' && <span className="liveDot">LIVE</span>}
        <span className="status">
          {g.state === 'pre' ? `${fmtDay(g.start)} · ${fmtTime(g.start)}` : visible ? g.statusText : g.state === 'in' ? 'In progress' : 'Final'}
        </span>
        {clutch.clutch && visible && <span className="clutchTag"><Flame /> CLUTCH</span>}
      </div>
      {row('away')}
      {row('home')}
      {g.state === 'in' && visible && g.situation?.text && (
        <div className={`situation ${g.situation.isRedZone ? 'rz' : ''}`}>{g.situation.isRedZone && 'RED ZONE · '}{g.situation.text}</div>
      )}
      {g.state === 'in' && visible && g.league === 'mlb' && g.situation?.onBase && (
        <div className="situation diamond">
          <span className={`base b2 ${g.situation.onBase.second ? 'on' : ''}`} />
          <span className={`base b3 ${g.situation.onBase.third ? 'on' : ''}`} />
          <span className={`base b1 ${g.situation.onBase.first ? 'on' : ''}`} />
          <em>{g.situation.outs ?? 0} out</em>
        </div>
      )}
      {stakes && (
        <div className="stakes">
          {stakes.mine.length > 0 && <span className="mine">You: {stakes.mine.map((p) => p.name.split(' ').slice(-1)[0]).join(', ')}</span>}
          {stakes.theirs.length > 0 && <span className="theirs">Opp: {stakes.theirs.map((p) => p.name.split(' ').slice(-1)[0]).join(', ')}</span>}
        </div>
      )}
      {!compact && g.odds && g.state === 'pre' && (
        <div className="oddsLine">
          <span>{g.away.abbr} {fmtLine(spreadFor(g, g.away.abbr))}</span>
          <span>O/U {g.odds.overUnder ?? '—'}</span>
          <span>{g.home.abbr} {fmtLine(spreadFor(g, g.home.abbr))}</span>
        </div>
      )}
      <div className="gcFoot">
        <span className="net" title={g.broadcasts.join(', ')}><Tv />{g.broadcasts[0] ?? 'TBD'}</span>
        {!visible && g.state !== 'pre' && (
          <button className="ghost" onClick={() => app.update((s) => ({ settings: { ...s.settings, revealed: [...s.settings.revealed, g.id] } }))}><Eye /> Reveal</button>
        )}
        <button className="ghost" onClick={toggleSchedule} title={scheduled ? 'Remove from schedule' : 'Add to schedule'}>{scheduled ? <Check /> : <CalendarPlus />}</button>
        {g.state !== 'post' && (
          match ? (
            <button className="watchBtn" onClick={watch} title={`${match.channel.name} · ${Math.round(match.confidence * 100)}% match`}><Play /> {match.channel.name}</button>
          ) : (
            <button className="ghost" onClick={() => navigate('settings', 'mapping')} title="Map this network to a channel">Map channel</button>
          )
        )}
      </div>
    </div>
  );
}

/** Tiny score bug overlaid on the player when the tuned channel carries a live game. */
export function ScoreBug({ g }: { g: SportEvent }) {
  const app = useApp();
  if (!showScore(app, g.id)) return <div className="scoreBug"><span>{g.away.abbr} @ {g.home.abbr}</span><em>Spoiler shield on</em></div>;
  return (
    <div className="scoreBug">
      <span style={{ borderColor: g.away.color }}>{g.away.abbr} <b>{g.awayScore}</b></span>
      <span style={{ borderColor: g.home.color }}>{g.home.abbr} <b>{g.homeScore}</b></span>
      <em>{g.statusText}</em>
      {g.situation?.text && <small className={g.situation.isRedZone ? 'rz' : ''}>{g.situation.text}</small>}
    </div>
  );
}
