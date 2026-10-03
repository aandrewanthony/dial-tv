import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Layers, Plus, Star, X } from 'lucide-react';
import { useApp } from '../../store/app';
import { useBets, useLineHistory, useOdds } from '../../store/bets';
import {
  bookInfo, espnOddsEvent, matchGame, offerOf, summarizeSide, type BookLine, type MarketKey, type Offer, type OddsEvent, type Side,
} from '../../providers/oddsapi';
import { fmtAmerican, fmtLine, fmtPct, impliedProb, isSoccer, leagueLabel, noVig, probToAmerican, type BetLeg } from '../../lib/sports';
import { startOfDay, HOUR } from '../../lib/scheduler';
import { Empty, TeamLogo, fmtDay, fmtTime } from '../ui';
import type { League, SportEvent } from '../../types';
import { BookButton, Sparkline, uid, useSlip } from './betsUi';

export interface BoardGame {
  key: string;
  ev: OddsEvent;
  game?: SportEvent;
}

/** Odds API events (matched to ESPN games) where we have them, ESPN's single line otherwise. */
export function boardGames(events: Partial<Record<League, OddsEvent[]>>, games: SportEvent[], now = Date.now()): BoardGame[] {
  const out: BoardGame[] = [];
  const covered = new Set<string>();
  for (const evs of Object.values(events)) {
    for (const ev of evs ?? []) {
      if (ev.commence < now - 4 * HOUR) continue;
      const game = matchGame(ev, games);
      if (game?.state === 'post') continue;
      if (game) covered.add(game.id);
      out.push({ key: game?.id ?? `oddsapi:${ev.id}`, ev, game });
    }
  }
  for (const g of games) {
    if (covered.has(g.id) || g.state === 'post' || g.start < now - 4 * HOUR) continue;
    if (events[g.league]?.length) continue; // league comes from the API: don't mix in ESPN rows
    const ev = espnOddsEvent(g);
    if (ev) out.push({ key: `espn:${g.id}`, ev, game: g });
  }
  return out.sort((a, b) => a.ev.commence - b.ev.commence);
}

interface Pick {
  bg: BoardGame;
  book: BookLine;
  market: MarketKey;
  side: Side;
  offer: Offer;
}

const abbrOf = (bg: BoardGame, side: 'home' | 'away') => bg.game?.[side].abbr ?? bg.ev[side].split(' ').slice(-1)[0].slice(0, 4).toUpperCase();

export function legFromPick(p: Pick): BetLeg & { book: string; link?: string } {
  const { bg, market, side, offer } = p;
  const g = bg.game;
  const game = `${abbrOf(bg, 'away')} @ ${abbrOf(bg, 'home')}`;
  return {
    id: uid(),
    eventId: g?.id,
    league: bg.ev.league,
    start: bg.ev.commence,
    game,
    market: market === 'ml' ? 'moneyline' : market === 'spread' ? 'spread' : 'total',
    side: side === 'home' || side === 'away' ? abbrOf(bg, side) : side,
    line: market === 'ml' ? undefined : offer.point,
    odds: offer.price,
    book: p.book.book,
    link: offer.link ?? p.book.link,
  };
}

const ROWS: [MarketKey, Side, string][] = [
  ['spread', 'away', 'Spread'], ['spread', 'home', ''],
  ['ml', 'away', 'Moneyline'], ['ml', 'home', ''], ['ml', 'draw', ''],
  ['total', 'over', 'Total'], ['total', 'under', ''],
];

function Movement({ k }: { k: string }) {
  const hist = useLineHistory((s) => s.lines[k]);
  if (!hist || hist.length < 2) return <span className="move muted small">Line movement appears as it changes</span>;
  const sp = hist.filter((h) => h.spread != null).map((h) => h.spread!);
  const tot = hist.filter((h) => h.total != null).map((h) => h.total!);
  const one = (label: string, vals: number[], fmt: (n: number) => string) => {
    if (vals.length < 2) return null;
    const a = vals[0];
    const b = vals[vals.length - 1];
    return (
      <span className="moveItem" title={`${label}: opened ${fmt(a)}, now ${fmt(b)}`}>
        {label} {fmt(a)} → <b>{fmt(b)}</b>{b > a ? <ArrowUp className="up" /> : b < a ? <ArrowDown className="down" /> : null}
        <Sparkline values={vals} />
      </span>
    );
  };
  return <span className="move">{one('Home spread', sp, fmtLine)}{one('Total', tot, String)}</span>;
}

function GameOdds({ bg, books, onPick, picked }: { bg: BoardGame; books: string[]; onPick: (p: Pick) => void; picked?: Pick }) {
  const { ev, game } = bg;
  const columns = useMemo(() => {
    const byKey = new Map(ev.books.map((b) => [b.book, b]));
    const ordered = books.filter((k) => byKey.has(k)).map((k) => byKey.get(k)!);
    // ESPN-only rows: whatever book ESPN shows. Odds API: the chosen books, else everything.
    return ev.source === 'espn' || !ordered.length ? ev.books : ordered;
  }, [ev, books]);
  const soccer = isSoccer(ev.league);
  const name = (side: Side) => (side === 'home' ? game?.home.shortName ?? ev.home : side === 'away' ? game?.away.shortName ?? ev.away : side === 'draw' ? 'Draw' : side === 'over' ? 'Over' : 'Under');

  return (
    <div className="oddsGame">
      <div className="ogHead">
        {game && <TeamLogo team={game.away} size={22} />}
        <b>{game ? `${game.away.shortName} @ ${game.home.shortName}` : `${ev.away} @ ${ev.home}`}</b>
        {game && <TeamLogo team={game.home} size={22} />}
        <span className="muted small">{leagueLabel(ev.league)} · {game?.state === 'in' ? <span className="liveDot">LIVE</span> : `${fmtDay(ev.commence)} ${fmtTime(ev.commence)}`}</span>
        <span className="spacer" />
        <Movement k={bg.key} />
      </div>
      <div className="ogScroll">
        <table className="oddsTable">
          <thead>
            <tr>
              <th />
              {columns.map((b) => <th key={b.book} style={{ ['--book' as string]: bookInfo(b.book, b.title).color }}><span className="bookName">{bookInfo(b.book, b.title).title}</span></th>)}
              <th title="Best available price">Best</th>
              <th title="No-vig fair price: the books' margin removed">Fair</th>
              <th title="Median line across books">Cons.</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([m, side, label]) => {
              if (side === 'draw' && !columns.some((b) => b.ml?.draw)) return null;
              if (!columns.some((b) => offerOf(b, m, side))) return null;
              const sum = summarizeSide(columns, m, side);
              return (
                <tr key={m + side} className={label ? 'mStart' : ''}>
                  <th><small>{label}</small>{name(side)}</th>
                  {columns.map((b, i) => {
                    const o = offerOf(b, m, side);
                    const isPicked = picked && picked.bg.key === bg.key && picked.book.book === b.book && picked.market === m && picked.side === side;
                    return (
                      <td key={b.book}>
                        {o ? (
                          <button className={`oddCell ${i === sum.best && columns.length > 1 ? 'best' : ''} ${isPicked ? 'on' : ''}`} onClick={() => onPick({ bg, book: b, market: m, side, offer: o })} title={`${bookInfo(b.book, b.title).title}: implied ${fmtPct(impliedProb(o.price))}`}>
                            {o.point != null && <span className="pt">{m === 'total' ? o.point : fmtLine(o.point)}</span>}
                            <span className="pr">{fmtAmerican(o.price)}</span>
                          </button>
                        ) : <span className="dim">—</span>}
                      </td>
                    );
                  })}
                  <td className="sumCell">{sum.bestOffer ? <><b>{sum.bestOffer.point != null ? `${m === 'total' ? sum.bestOffer.point : fmtLine(sum.bestOffer.point)} ` : ''}{fmtAmerican(sum.bestOffer.price)}</b><small>{fmtPct(sum.implied)}</small></> : '—'}</td>
                  <td className="sumCell">{sum.fair != null ? <><b>{fmtAmerican(probToAmerican(sum.fair))}</b><small>{fmtPct(sum.fair)}</small></> : '—'}</td>
                  <td className="sumCell">{sum.consensusPoint != null ? (m === 'total' ? sum.consensusPoint : fmtLine(sum.consensusPoint)) : fmtAmerican(sum.consensusPrice)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {soccer && <p className="muted small">Soccer moneylines are 3-way (90 minutes + stoppage): a draw loses both team bets.</p>}
    </div>
  );
}

export function OddsBoard({ onTrack }: { onTrack: (legs: (BetLeg & { book?: string })[], book?: string) => void }) {
  const games = useApp((s) => s.games);
  const leagues = useApp((s) => s.leagues);
  const favTeams = useApp((s) => s.favTeams);
  const events = useOdds((s) => s.events);
  const books = useBets((s) => s.books);
  const addToSlip = useSlip((s) => s.add);
  const [league, setLeague] = useState<League | 'all'>('all');
  const [day, setDay] = useState<'today' | 'tomorrow' | 'week'>('week');
  const [mine, setMine] = useState(false);
  const [picked, setPicked] = useState<Pick>();

  const list = useMemo(() => {
    const all = boardGames(events, Object.values(games));
    const today = startOfDay(Date.now());
    return all.filter(({ ev, game }) => {
      if (league !== 'all' && ev.league !== league) return false;
      if (!leagues.includes(ev.league)) return false;
      const d = startOfDay(ev.commence);
      if (day === 'today' && d > today) return false;
      if (day === 'tomorrow' && d !== startOfDay(today + 26 * HOUR)) return false;
      if (mine && !(game && (favTeams.includes(`${game.league}:${game.home.abbr}`) || favTeams.includes(`${game.league}:${game.away.abbr}`)))) return false;
      return true;
    });
  }, [events, games, league, leagues, day, mine, favTeams]);

  const p = picked;
  const fair = p ? (() => {
    const sides: Side[] = p.market === 'ml' ? (p.book.ml?.draw ? ['home', 'away', 'draw'] : ['home', 'away']) : p.market === 'spread' ? ['home', 'away'] : ['over', 'under'];
    const os = sides.map((s) => offerOf(p.book, p.market, s));
    return os.every(Boolean) ? noVig(os.map((o) => o!.price))[sides.indexOf(p.side)] : undefined;
  })() : undefined;

  return (
    <div className="oddsBoard">
      <div className="guideBar">
        <div className="chips">
          <button className={league === 'all' ? 'on' : ''} onClick={() => setLeague('all')}>ALL</button>
          {leagues.map((l) => <button key={l} className={league === l ? 'on' : ''} onClick={() => setLeague(l)}>{leagueLabel(l)}</button>)}
        </div>
        <div className="chips">
          {(['today', 'tomorrow', 'week'] as const).map((d) => <button key={d} className={day === d ? 'on' : ''} onClick={() => setDay(d)}>{d === 'week' ? 'Next 7 days' : d === 'today' ? 'Today' : 'Tomorrow'}</button>)}
          <button className={mine ? 'on' : ''} onClick={() => setMine(!mine)}><Star /> My teams</button>
        </div>
      </div>
      {!list.length ? (
        <Empty icon={<Layers />} title="No lines to show">Nothing matches these filters yet. Lines appear for upcoming games in your leagues.</Empty>
      ) : list.map((bg) => <GameOdds key={bg.key} bg={bg} books={books} onPick={setPicked} picked={picked} />)}

      {p && (
        <div className="pickBar" role="region" aria-label="Selected line">
          <div className="pbInfo">
            <b>{bookInfo(p.book.book, p.book.title).title}</b>
            <span>{legFromPick(p).game} · {p.market === 'ml' ? `${legFromPick(p).side} ML` : p.market === 'spread' ? `${legFromPick(p).side} ${fmtLine(p.offer.point)}` : `${p.side === 'over' ? 'Over' : 'Under'} ${p.offer.point}`} <b>{fmtAmerican(p.offer.price)}</b></span>
            <small>Implied {fmtPct(impliedProb(p.offer.price))}{fair != null ? ` · no-vig ${fmtPct(fair)} (${fmtAmerican(probToAmerican(fair))})` : ''}</small>
          </div>
          <BookButton book={p.book.book} title={p.book.title} link={p.offer.link ?? p.book.link} />
          <button className="ghost" onClick={() => onTrack([legFromPick(p)], p.book.book)}><Plus /> Track bet</button>
          <button className="ghost" onClick={() => { addToSlip(legFromPick(p)); setPicked(undefined); }}><Layers /> Add to parlay</button>
          <button className="icon" aria-label="Clear selection" onClick={() => setPicked(undefined)}><X /></button>
        </div>
      )}
    </div>
  );
}
