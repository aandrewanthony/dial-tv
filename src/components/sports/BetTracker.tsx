import { useMemo, useState } from 'react';
import { Download, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useApp } from '../../store/app';
import { useBets, type Bet, type BetLeg } from '../../store/bets';
import { BOOKS, bookInfo } from '../../providers/oddsapi';
import {
  betProfit, betSport, betsToCsv, fmtAmerican, fmtMoney, fmtPct, groupSummary, isSoccer, LEAGUES, leagueLabel, legLabel, parlayPrice,
  potentialReturn, settleBet, summarize, weeklyProfit, type BetMarket, type BetStatus,
} from '../../lib/sports';
import { Empty, Modal, fmtDay, fmtTime } from '../ui';
import type { League } from '../../types';
import { BookButton, WeeklyChart, uid } from './betsUi';

export function bankrollBalance(s: { bankrollStart: number; bankroll: { amount: number }[]; bets: Bet[] }) {
  const moves = s.bankroll.reduce((a, b) => a + b.amount, 0);
  const pl = s.bets.reduce((a, b) => a + betProfit(b), 0);
  const open = s.bets.filter((b) => b.status === 'open').reduce((a, b) => a + b.stake, 0);
  return { balance: s.bankrollStart + moves + pl - open, pl, open };
}

const STATUS_LABEL: Record<BetStatus, string> = { open: 'Open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void', cashout: 'Cashed out' };

// ---------- Add / edit bet ----------

type Draft = BetLeg & { book?: string };

function LegEditor({ leg, onChange, onRemove }: { leg: Draft; onChange: (l: Draft) => void; onRemove?: () => void }) {
  const games = useApp((s) => s.games);
  const options = useMemo(
    () => Object.values(games).filter((g) => g.start > Date.now() - 2 * 86400e3).sort((a, b) => a.start - b.start),
    [games],
  );
  const g = leg.eventId ? games[leg.eventId] : undefined;
  const teams = g ? [g.away.abbr, g.home.abbr] : [];
  const sides = leg.market === 'total' ? ['over', 'under'] : [...teams, ...(leg.market === 'moneyline' && isSoccer(leg.league) ? ['draw'] : [])];
  const set = (p: Partial<Draft>) => onChange({ ...leg, ...p });
  return (
    <div className="legEdit">
      <div className="row">
        <label className="lbl">Game
          <select className="field" aria-label="Game" value={leg.eventId ?? ''} onChange={(e) => {
            const ng = games[e.target.value];
            if (!ng) return set({ eventId: undefined });
            set({ eventId: ng.id, league: ng.league, start: ng.start, game: `${ng.away.abbr} @ ${ng.home.abbr}`, side: leg.market === 'total' ? leg.side : ng.away.abbr });
          }}>
            <option value="">Other (not in Scores — settle by hand)</option>
            {options.map((x) => <option key={x.id} value={x.id}>{leagueLabel(x.league)} · {x.away.abbr} @ {x.home.abbr} · {fmtDay(x.start)} {fmtTime(x.start)}</option>)}
          </select>
        </label>
        {!leg.eventId && (
          <>
            <label className="lbl">Event<input className="field" aria-label="Event" value={leg.game} placeholder="e.g. BUF @ KC" onChange={(e) => set({ game: e.target.value })} /></label>
            <label className="lbl small">League
              <select className="field" value={leg.league} onChange={(e) => set({ league: e.target.value as League })}>{LEAGUES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
            </label>
          </>
        )}
      </div>
      <div className="row">
        <label className="lbl">Market
          <select className="field" aria-label="Market" value={leg.market} onChange={(e) => {
            const m = e.target.value as BetMarket;
            set({ market: m, side: m === 'total' ? 'over' : teams[0] ?? '', line: m === 'moneyline' ? undefined : leg.line });
          }}>
            <option value="spread">Spread</option><option value="moneyline">Moneyline</option><option value="total">Total</option>
          </select>
        </label>
        <label className="lbl">Side
          {sides.length ? (
            <select className="field" aria-label="Side" value={leg.side} onChange={(e) => set({ side: e.target.value })}>
              {sides.map((s) => <option key={s} value={s}>{s === 'over' ? 'Over' : s === 'under' ? 'Under' : s === 'draw' ? 'Draw' : s}</option>)}
            </select>
          ) : <input className="field" aria-label="Side" value={leg.side} placeholder="Team" onChange={(e) => set({ side: e.target.value.toUpperCase() })} />}
        </label>
        {leg.market !== 'moneyline' && (
          <label className="lbl small">Line<input className="field" aria-label="Line" type="number" step="0.5" value={leg.line ?? ''} onChange={(e) => set({ line: e.target.value === '' ? undefined : +e.target.value })} /></label>
        )}
        <label className="lbl small">Odds<input className="field" aria-label="Odds" type="number" value={leg.odds || ''} placeholder="-110" onChange={(e) => set({ odds: +e.target.value })} /></label>
        {onRemove && <button className="icon" aria-label="Remove leg" onClick={onRemove}><Trash2 /></button>}
      </div>
    </div>
  );
}

const blankLeg = (): Draft => ({ id: uid(), league: 'nfl', game: '', market: 'spread', side: '', odds: -110 });

export function AddBetModal({ initial, initialBook, onClose }: { initial?: Draft[]; initialBook?: string; onClose: (saved?: boolean) => void }) {
  const maxStake = useBets((s) => s.limits.maxStake);
  const [book, setBook] = useState(initialBook ?? initial?.[0]?.book ?? 'fanduel');
  const [legs, setLegs] = useState<Draft[]>(initial?.length ? initial : [blankLeg()]);
  const [type, setType] = useState<'straight' | 'parlay'>(legs.length > 1 ? 'parlay' : 'straight');
  const combined = parlayPrice(legs.map((l) => l.odds).filter((o) => o)).american;
  const [oddsOverride, setOddsOverride] = useState<number | undefined>();
  const [stake, setStake] = useState(10);
  const [notes, setNotes] = useState('');
  const odds = type === 'parlay' ? oddsOverride ?? combined : legs[0]?.odds;
  const valid = stake > 0 && odds && legs.every((l) => l.odds && (l.eventId || l.game.trim()) && l.side && (l.market === 'moneyline' || l.line != null)) && (type === 'straight' || legs.length >= 2);
  const overLimit = maxStake != null && stake > maxStake;

  const save = () => {
    if (!valid) return;
    const bet: Bet = {
      id: uid(),
      book,
      type,
      legs: (type === 'straight' ? legs.slice(0, 1) : legs).map(({ book: _b, ...l }) => ({ ...l, game: l.game.trim(), result: undefined })),
      odds: odds!,
      stake,
      placedAt: Date.now(),
      notes: notes.trim() || undefined,
      status: 'open',
    };
    useBets.setState((s) => ({ bets: [bet, ...s.bets] }));
    onClose(true);
  };

  return (
    <Modal title="Track a bet" onClose={() => onClose()} wide>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="row">
          <label className="lbl">Sportsbook
            <select className="field" aria-label="Sportsbook" value={book} onChange={(e) => setBook(e.target.value)}>
              {BOOKS.map((b) => <option key={b.key} value={b.key}>{b.title}</option>)}
              <option value="other">Other</option>
            </select>
          </label>
          <div className="chips" role="group" aria-label="Bet type">
            <button type="button" className={type === 'straight' ? 'on' : ''} onClick={() => setType('straight')}>Straight</button>
            <button type="button" className={type === 'parlay' ? 'on' : ''} onClick={() => { setType('parlay'); if (legs.length < 2) setLegs([...legs, blankLeg()]); }}>Parlay</button>
          </div>
        </div>
        {(type === 'straight' ? legs.slice(0, 1) : legs).map((l, i) => (
          <LegEditor key={l.id} leg={l} onChange={(n) => setLegs(legs.map((x, j) => (j === i ? n : x)))} onRemove={type === 'parlay' && legs.length > 2 ? () => setLegs(legs.filter((_, j) => j !== i)) : undefined} />
        ))}
        {type === 'parlay' && <button type="button" className="ghost" onClick={() => setLegs([...legs, blankLeg()])}><Plus /> Add leg</button>}
        <div className="row">
          {type === 'parlay' && (
            <label className="lbl small">Ticket odds<input className="field" aria-label="Ticket odds" type="number" value={odds || ''} onChange={(e) => setOddsOverride(e.target.value === '' ? undefined : +e.target.value)} /></label>
          )}
          <label className="lbl small">Stake ($)<input className="field" aria-label="Stake" type="number" min={0} step="0.01" value={stake} onChange={(e) => setStake(+e.target.value)} /></label>
          <span className="muted small">To win {fmtMoney(odds ? potentialReturn({ stake, odds }) - stake : 0)} · pays {fmtMoney(odds ? potentialReturn({ stake, odds }) : 0)}</span>
        </div>
        {overLimit && <div className="banner warn">This stake is above your {fmtMoney(maxStake!)} per-bet limit.</div>}
        <label>Notes<input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" /></label>
        <p className="muted small">Tracking only: Dial TV never places bets or talks to your sportsbook. Bets tied to a game in Scores grade themselves when it goes final.</p>
        <div className="row">
          <span className="spacer" />
          <button type="button" className="ghost" onClick={() => onClose()}>Cancel</button>
          <button className="primary" disabled={!valid}>Save bet</button>
        </div>
      </form>
    </Modal>
  );
}

function SettleModal({ bet, onClose }: { bet: Bet; onClose: () => void }) {
  const [amount, setAmount] = useState(String(Math.round(bet.stake * 100) / 100));
  const settle = (status: BetStatus, returned?: number) => {
    useBets.setState((s) => ({
      bets: s.bets.map((b) => (b.id === bet.id ? { ...b, status, returned, manual: true, settledAt: Date.now() } : b)),
    }));
    onClose();
  };
  return (
    <Modal title="Settle by hand" onClose={onClose}>
      <div className="form">
        <p className="muted small">Overrides auto-grading for this bet. “Back to auto” undoes it.</p>
        <div className="row">
          <button className="ghost" onClick={() => settle('won', potentialReturn(bet))}>Won ({fmtMoney(potentialReturn(bet))})</button>
          <button className="ghost" onClick={() => settle('lost', 0)}>Lost</button>
          <button className="ghost" onClick={() => settle('push', bet.stake)}>Push</button>
          <button className="ghost" onClick={() => settle('void', bet.stake)}>Void</button>
        </div>
        <div className="row">
          <label className="lbl">Cash-out amount ($)<input className="field" aria-label="Cash-out amount" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <button className="primary" disabled={!(+amount >= 0)} onClick={() => settle('cashout', +amount)}>Cash out</button>
        </div>
      </div>
    </Modal>
  );
}

function BetRow({ b, onSettle }: { b: Bet; onSettle: () => void }) {
  const profit = betProfit(b);
  const info = bookInfo(b.book);
  return (
    <div className={`betRow ${b.status}`} data-status={b.status}>
      <span className="bookTag" style={{ ['--book' as string]: info.color }}>{b.book === 'other' ? 'Other' : info.title}</span>
      <div className="brMain">
        <b>{b.type === 'parlay' ? `${b.legs.length}-leg parlay` : legLabel(b.legs[0])}</b>
        <small>
          {b.type === 'parlay' ? b.legs.map((l) => `${legLabel(l)}${l.result ? ` (${l.result})` : ''}`).join(' · ') : `${b.legs[0].game} · ${leagueLabel(b.legs[0].league)}`}
          {b.notes ? ` · ${b.notes}` : ''}
        </small>
      </div>
      <span className="mono">{fmtAmerican(b.odds)}</span>
      <span className="mono">{fmtMoney(b.stake)}</span>
      <span className={`statusPill ${b.status}`}>{STATUS_LABEL[b.status]}{b.manual ? '*' : ''}</span>
      <span className={`mono pl ${profit > 0 ? 'up' : profit < 0 ? 'down' : ''}`}>{b.status === 'open' ? `to win ${fmtMoney(potentialReturn(b) - b.stake)}` : fmtMoney(profit, true)}</span>
      <div className="brActions">
        {b.status === 'open' && <BookButton book={b.book} label="Open" />}
        {b.manual ? (
          <button className="icon" title="Back to auto-grading" aria-label="Back to auto-grading" onClick={() => useBets.setState((s) => ({ bets: s.bets.map((x) => (x.id === b.id ? settleBet({ ...x, manual: false, status: 'open', returned: undefined, settledAt: undefined }) : x)) }))}><RotateCcw /></button>
        ) : <button className="ghost small" onClick={onSettle}>Settle</button>}
        <button className="icon" aria-label="Delete bet" onClick={() => { if (confirm('Delete this bet from your tracker?')) useBets.setState((s) => ({ bets: s.bets.filter((x) => x.id !== b.id) })); }}><Trash2 /></button>
      </div>
    </div>
  );
}

export function BetTracker({ onAdd }: { onAdd: () => void }) {
  const bets = useBets((s) => s.bets);
  const bankrollStart = useBets((s) => s.bankrollStart);
  const bankroll = useBets((s) => s.bankroll);
  const [filter, setFilter] = useState<'open' | 'settled' | 'all'>('all');
  const [group, setGroup] = useState<'book' | 'sport' | 'type'>('book');
  const [settling, setSettling] = useState<Bet>();
  const sum = useMemo(() => summarize(bets), [bets]);
  const bal = bankrollBalance({ bankrollStart, bankroll, bets });
  const weekly = useMemo(() => weeklyProfit(bets), [bets]);
  const groups = useMemo(() => groupSummary(bets, (b) => (group === 'book' ? bookInfo(b.book).title : group === 'sport' ? betSport(b) : b.type === 'parlay' ? 'Parlay' : 'Straight')), [bets, group]);
  const shown = bets.filter((b) => filter === 'all' || (filter === 'open' ? b.status === 'open' : b.status !== 'open'));

  const exportCsv = () => {
    const blob = new Blob([betsToCsv(bets, (k) => bookInfo(k).title)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dial-tv-bets-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="betTracker">
      <div className="tiles">
        {bankrollStart || bankroll.length ? (
          <div className="tile"><small>Bankroll</small><b>{fmtMoney(bal.balance)}</b><em>{fmtMoney(bal.open)} in play</em></div>
        ) : (
          <div className="tile"><small>Bankroll</small><b>—</b><em>Set a starting bankroll in Settings · {fmtMoney(bal.open)} in play</em></div>
        )}
        <div className="tile"><small>Profit / loss</small><b className={sum.profit > 0 ? 'up' : sum.profit < 0 ? 'down' : ''}>{fmtMoney(sum.profit, true)}</b><em>ROI {fmtPct(sum.roi)}</em></div>
        <div className="tile"><small>Record</small><b>{sum.won}-{sum.lost}-{sum.pushed}</b><em>W-L-P</em></div>
        <div className="tile"><small>Open</small><b>{sum.open}</b><em>{fmtMoney(sum.openStake)} staked</em></div>
      </div>

      <div className="trackerGrid">
        <section className="panel">
          <h3 className="sectionTitle">WEEKLY P/L</h3>
          <WeeklyChart data={weekly} />
        </section>
        <section className="panel">
          <h3 className="sectionTitle">BREAKDOWN
            <span className="chips">{(['book', 'sport', 'type'] as const).map((g) => <button key={g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>By {g}</button>)}</span>
          </h3>
          {groups.length ? (
            <table className="miniTable">
              <thead><tr><th /><th>Bets</th><th>W-L-P</th><th>P/L</th><th>ROI</th></tr></thead>
              <tbody>{groups.map(([k, s]) => <tr key={k}><th>{k}</th><td>{s.bets}</td><td>{s.won}-{s.lost}-{s.pushed}</td><td className={s.profit > 0 ? 'up' : s.profit < 0 ? 'down' : ''}>{fmtMoney(s.profit, true)}</td><td>{fmtPct(s.roi)}</td></tr>)}</tbody>
            </table>
          ) : <p className="muted small">Your splits show up here.</p>}
        </section>
      </div>

      <div className="guideBar">
        <div className="chips">
          {(['all', 'open', 'settled'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>)}
        </div>
        <div className="chips">
          <button onClick={exportCsv} disabled={!bets.length}><Download /> Export CSV</button>
          <button className="primary" onClick={onAdd}><Plus /> Add bet</button>
        </div>
      </div>
      {shown.length ? <div className="betList">{shown.map((b) => <BetRow key={b.id} b={b} onSettle={() => setSettling(b)} />)}</div> : (
        <Empty title="No bets tracked">Add bets you place at FanDuel or any book — from the odds board (“Track bet”) or by hand. They grade themselves from final scores.</Empty>
      )}
      <p className="muted small">* settled by hand. Auto-grading: spreads, totals and moneylines from final scores; pushes return the stake; postponed/canceled games are void; soccer moneylines are 3-way; parlay pushes/voids drop the leg and reprice.</p>
      {settling && <SettleModal bet={settling} onClose={() => setSettling(undefined)} />}
    </div>
  );
}
