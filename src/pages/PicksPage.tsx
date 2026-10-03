import { useMemo, useState } from 'react';
import { Eye, Plus, Swords, Trash2, Trophy } from 'lucide-react';
import { showScore, useApp } from '../store/app';
import type { BetPick, PickMarket, SportEvent } from '../types';
import { fmtLine, gradePick, LEAGUES, leagueLabel, pickProfit, recordFor, spreadFor } from '../lib/sports';
import { Empty, TeamLogo, fmtDay, fmtTime } from '../components/ui';
import type { League } from '../types';

/** What a pick would be if the game ended right now. */
function liveStatus(p: BetPick, g?: SportEvent) {
  if (!g || g.state !== 'in') return undefined;
  return gradePick(p, { ...g, state: 'post' });
}

export default function PicksPage() {
  const games = useApp((s) => s.games);
  const picks = useApp((s) => s.picks);
  const pickPlayers = useApp((s) => s.pickPlayers);
  const leagues = useApp((s) => s.leagues);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.update);
  const vis = (id: string) => showScore({ settings }, id);
  const reveal = (id: string) => update((st) => ({ settings: { ...st.settings, revealed: [...st.settings.revealed, id] } }));
  const [player, setPlayer] = useState(pickPlayers[0] ?? 'Me');
  const [units, setUnits] = useState(1);
  const [league, setLeague] = useState<League | 'all'>('all');
  const [newName, setNewName] = useState('');

  const upcoming = useMemo(
    () => Object.values(games)
      .filter((g) => g.state === 'pre' && g.odds && (league === 'all' || g.league === league) && g.start < Date.now() + 7 * 864e5)
      .sort((a, b) => a.start - b.start),
    [games, league],
  );

  const add = (g: SportEvent, market: PickMarket, side: string) => {
    if (g.start <= Date.now()) return;
    let line: number | undefined;
    let price: string | undefined;
    let label: string;
    if (market === 'spread') {
      line = spreadFor(g, side);
      price = '-110';
      label = `${side} ${fmtLine(line)}`;
    } else if (market === 'moneyline') {
      price = side === g.home.abbr ? g.odds?.homeMoneyline : g.odds?.awayMoneyline;
      label = `${side} ML ${price ?? ''}`;
    } else {
      line = g.odds?.overUnder;
      price = '-110';
      label = `${side === 'over' ? 'Over' : 'Under'} ${line}`;
    }
    const pick: BetPick = {
      id: `${player}|${g.id}|${market}`,
      player, eventId: g.id, league: g.league, start: g.start, market, side, line, price, units, createdAt: Date.now(),
      label: `${label} · ${g.away.abbr} @ ${g.home.abbr}`,
    };
    // One pick per player per game per market: replace.
    update((st) => ({ picks: [...st.picks.filter((p) => p.id !== pick.id), pick] }));
  };

  const myPick = (g: SportEvent, market: PickMarket) => picks.find((p) => p.id === `${player}|${g.id}|${market}`);
  const records = pickPlayers.map((p) => recordFor(p, picks)).sort((a, b) => b.units - a.units);

  const ledger = [...picks].sort((a, b) => (a.result ? 1 : 0) - (b.result ? 1 : 0) || (games[b.eventId]?.start ?? 0) - (games[a.eventId]?.start ?? 0));

  // Rivalry: the two of you on opposite sides of the same market.
  const rivalries = useMemo(() => {
    const m = new Map<string, BetPick[]>();
    for (const p of picks) if (!p.result) m.set(`${p.eventId}|${p.market}`, [...(m.get(`${p.eventId}|${p.market}`) ?? []), p]);
    return [...m.values()].filter((arr) => new Set(arr.map((p) => p.side)).size > 1);
  }, [picks]);

  const btn = (g: SportEvent, market: PickMarket, side: string, text: string) => {
    const mp = myPick(g, market);
    const others = picks.filter((p) => p.eventId === g.id && p.market === market && p.side === side && p.player !== player);
    return (
      <button className={`oddBtn ${mp?.side === side ? 'on' : ''}`} onClick={() => (mp?.side === side ? update((st) => ({ picks: st.picks.filter((p) => p.id !== mp.id) })) : add(g, market, side))}>
        {text}
        {others.length > 0 && <i title={others.map((o) => o.player).join(', ')}>{others.map((o) => o.player[0]).join('')}</i>}
      </button>
    );
  };

  return (
    <div className="picksPage">
      <div className="banner">For fun between you two — lines are shown for reference (ESPN), units are imaginary, no money moves anywhere. Picks lock at kickoff and grade themselves at the final whistle.</div>

      <div className="leaderboard">
        {records.map((r, i) => (
          <div key={r.player} className={`lb ${i === 0 && r.units > 0 ? 'lead' : ''}`}>
            {i === 0 && r.units > 0 && <Trophy />}
            <b>{r.player}</b>
            <span>{r.wins}-{r.losses}{r.pushes ? `-${r.pushes}` : ''}</span>
            <strong className={r.units >= 0 ? 'pos' : 'neg'}>{r.units >= 0 ? '+' : ''}{r.units.toFixed(2)}u</strong>
            <small>{r.streak} · {r.pending} open</small>
          </div>
        ))}
      </div>

      <div className="guideBar">
        <div className="chips">
          <span className="muted">Picking as</span>
          {pickPlayers.map((p) => <button key={p} className={player === p ? 'on' : ''} onClick={() => setPlayer(p)}>{p}</button>)}
          <form className="row" onSubmit={(e) => { e.preventDefault(); const n = newName.trim(); if (n && !pickPlayers.includes(n)) { update((st) => ({ pickPlayers: [...st.pickPlayers, n] })); setNewName(''); setPlayer(n); } }}>
            <input className="field small" placeholder="Add player" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button className="icon" aria-label="Add player"><Plus /></button>
          </form>
        </div>
        <div className="chips">
          <span className="muted">Units</span>
          {[1, 2, 3, 5].map((u) => <button key={u} className={units === u ? 'on' : ''} onClick={() => setUnits(u)}>{u}u</button>)}
        </div>
      </div>

      {rivalries.length > 0 && (
        <section>
          <h3 className="sectionTitle"><Swords /> HEAD-TO-HEAD</h3>
          <div className="rivals">
            {rivalries.map((arr) => {
              const g = games[arr[0].eventId];
              return (
                <div key={arr[0].eventId + arr[0].market} className="rival">
                  <small>{g ? `${g.away.abbr} @ ${g.home.abbr} · ${g.state === 'in' ? (vis(g.id) ? g.statusText : 'LIVE') : fmtDay(g.start) + ' ' + fmtTime(g.start)}` : ''}</small>
                  {arr.map((p) => {
                    const ls = g && vis(g.id) ? liveStatus(p, g) : undefined;
                    return <div key={p.id}><b>{p.player}</b> {p.label.split(' · ')[0]} {ls && <em className={ls}>{ls === 'win' ? 'covering' : ls === 'loss' ? 'not covering' : 'push'}</em>}</div>;
                  })}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="picksGrid">
        <section>
          <div className="guideBar">
            <h3 className="sectionTitle">ODDS BOARD</h3>
            <div className="chips">
              <button className={league === 'all' ? 'on' : ''} onClick={() => setLeague('all')}>ALL</button>
              {LEAGUES.filter((l) => leagues.includes(l.id)).map((l) => <button key={l.id} className={league === l.id ? 'on' : ''} onClick={() => setLeague(l.id)}>{l.label}</button>)}
            </div>
          </div>
          {!upcoming.length ? <Empty title="No lines yet">Lines appear for upcoming games in your enabled leagues.</Empty> : (
            <div className="board">
              <div className="bRow head"><span>Game</span><span>Spread</span><span>Moneyline</span><span>Total</span></div>
              {upcoming.map((g) => (
                <div key={g.id} className="bRow">
                  <div className="bGame">
                    <small>{leagueLabel(g.league)} · {fmtDay(g.start)} {fmtTime(g.start)}</small>
                    <div><TeamLogo team={g.away} size={20} />{g.away.abbr}</div>
                    <div><TeamLogo team={g.home} size={20} />{g.home.abbr}</div>
                  </div>
                  <div className="bCol">
                    {g.odds?.spread != null ? <>{btn(g, 'spread', g.away.abbr, fmtLine(spreadFor(g, g.away.abbr)))}{btn(g, 'spread', g.home.abbr, fmtLine(spreadFor(g, g.home.abbr)))}</> : <span className="muted">—</span>}
                  </div>
                  <div className="bCol">
                    {g.odds?.awayMoneyline || g.odds?.homeMoneyline ? <>{btn(g, 'moneyline', g.away.abbr, g.odds?.awayMoneyline ?? '—')}{btn(g, 'moneyline', g.home.abbr, g.odds?.homeMoneyline ?? '—')}</> : <span className="muted">—</span>}
                  </div>
                  <div className="bCol">
                    {g.odds?.overUnder != null ? <>{btn(g, 'total', 'over', `O ${g.odds.overUnder}`)}{btn(g, 'total', 'under', `U ${g.odds.overUnder}`)}</> : <span className="muted">—</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="sectionTitle">LEDGER</h3>
          {!ledger.length ? <p className="muted">No picks yet.</p> : ledger.map((p) => {
            const g = games[p.eventId];
            // Spoiler shield: no scores, grades or covering/sweating until the game is revealed.
            const shown = vis(p.eventId);
            const ls = shown ? liveStatus(p, g) : undefined;
            const started = !g || g.start <= Date.now();
            const hiddenRes = !shown && (p.result || (g && g.state !== 'pre'));
            return (
              <div key={p.id} className={`ledger ${!shown ? 'open' : p.result ?? (ls ? 'live-' + ls : 'open')}`}>
                <div>
                  <b>{p.player}</b> · {p.label}
                  <small>{p.units}u @ {p.price ?? '-110'} · {g ? (g.state === 'pre' ? `${fmtDay(g.start)} ${fmtTime(g.start)}` : shown ? `${g.away.abbr} ${g.awayScore} – ${g.home.abbr} ${g.homeScore} · ${g.statusText}` : `${g.away.abbr} @ ${g.home.abbr} · ${g.state === 'in' ? 'In progress' : 'Final'}`) : 'game no longer in window'}</small>
                </div>
                <span className="res">
                  {hiddenRes ? <button className="ghost" onClick={() => reveal(p.eventId)}><Eye /> Reveal</button>
                    : p.result ? `${p.result.toUpperCase()} ${pickProfit(p) >= 0 ? '+' : ''}${pickProfit(p).toFixed(2)}u` : ls ? (ls === 'win' ? 'COVERING' : ls === 'loss' ? 'SWEATING' : 'PUSH') : 'OPEN'}
                </span>
                {!started && <button className="icon" aria-label="Delete pick" onClick={() => update((st) => ({ picks: st.picks.filter((x) => x.id !== p.id) }))}><Trash2 /></button>}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
