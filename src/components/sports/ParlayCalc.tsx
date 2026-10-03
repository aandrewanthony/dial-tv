import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { americanToDecimal, fmtAmerican, fmtMoney, fmtPct, impliedProb, legLabel, parlayPrice } from '../../lib/sports';
import { bookInfo } from '../../providers/oddsapi';
import type { BetLeg } from '../../lib/sports';
import { uid, useSlip } from './betsUi';

/** Parlay calculator: legs from the odds board or typed in; combined odds, payout and implied probability. */
export function ParlayCalc({ onTrack }: { onTrack: (legs: (BetLeg & { book?: string })[], book?: string) => void }) {
  const legs = useSlip((s) => s.legs);
  const remove = useSlip((s) => s.remove);
  const clear = useSlip((s) => s.clear);
  const [manual, setManual] = useState<{ id: string; odds: number }[]>([]);
  const [stake, setStake] = useState(10);
  const all = [...legs.map((l) => l.odds), ...manual.map((m) => m.odds)].filter((o) => o && Math.abs(o) >= 100);
  const p = parlayPrice(all, stake);
  const books = [...new Set(legs.map((l) => l.book).filter(Boolean))] as string[];

  return (
    <div className="parlayCalc panel">
      <h3 className="sectionTitle">PARLAY CALCULATOR</h3>
      {legs.map((l) => (
        <div className="pcLeg" key={l.id}>
          <span className="bookTag" style={{ ['--book' as string]: bookInfo(l.book ?? '').color }}>{l.book ? bookInfo(l.book).title : '—'}</span>
          <span className="spacer">{legLabel(l)}</span>
          <b className="mono">{fmtAmerican(l.odds)}</b>
          <small className="muted">{fmtPct(impliedProb(l.odds))}</small>
          <button className="icon" aria-label="Remove leg" onClick={() => remove(l.id)}><Trash2 /></button>
        </div>
      ))}
      {manual.map((m, i) => (
        <div className="pcLeg" key={m.id}>
          <span className="spacer">Leg {legs.length + i + 1}</span>
          <input className="field small" type="number" aria-label={`Leg ${legs.length + i + 1} odds`} value={m.odds || ''} placeholder="-110" onChange={(e) => setManual(manual.map((x) => (x.id === m.id ? { ...x, odds: +e.target.value } : x)))} />
          <small className="muted">{m.odds && Math.abs(m.odds) >= 100 ? `${americanToDecimal(m.odds).toFixed(3)}×` : ''}</small>
          <button className="icon" aria-label="Remove leg" onClick={() => setManual(manual.filter((x) => x.id !== m.id))}><Trash2 /></button>
        </div>
      ))}
      <div className="row">
        <button className="ghost" onClick={() => setManual([...manual, { id: uid(), odds: -110 }])}><Plus /> Add leg</button>
        <label className="lbl small">Stake ($)<input className="field" aria-label="Parlay stake" type="number" min={0} value={stake} onChange={(e) => setStake(+e.target.value)} /></label>
      </div>
      <div className="pcOut">
        <div><small>Legs</small><b>{all.length}</b></div>
        <div><small>Odds</small><b>{all.length ? fmtAmerican(p.american) : '—'}</b><em>{all.length ? `${p.decimal.toFixed(2)}×` : ''}</em></div>
        <div><small>Pays</small><b>{fmtMoney(all.length ? p.payout : 0)}</b><em>profit {fmtMoney(all.length ? p.profit : 0)}</em></div>
        <div><small>Implied chance</small><b>{all.length ? fmtPct(p.prob) : '—'}</b><em>legs treated as independent</em></div>
      </div>
      <div className="row">
        {(legs.length > 0 || manual.length > 0) && <button className="ghost" onClick={() => { clear(); setManual([]); }}>Clear</button>}
        <span className="spacer" />
        {legs.length >= 2 && !manual.length && <button className="primary" onClick={() => onTrack(legs, books.length === 1 ? books[0] : undefined)}>Track this parlay</button>}
      </div>
      <p className="muted small">Same-game parlays are priced with correlation by the books, so their real odds differ from this product.</p>
    </div>
  );
}
