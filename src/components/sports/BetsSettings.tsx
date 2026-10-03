import { useEffect, useState } from 'react';
import { ExternalLink, KeyRound, Lock, PauseCircle, Trash2 } from 'lucide-react';
import { useBets, useOdds } from '../../store/bets';
import { BOOKS, CREDITS_PER_REFRESH, ODDS_API_SIGNUP } from '../../providers/oddsapi';
import { getSecret, secretsAreEncrypted, setSecret } from '../../lib/secrets';
import { fmtMoney } from '../../lib/sports';
import { useApp } from '../../store/app';
import { openExternal, uid } from './betsUi';

function ApiKey() {
  const hasKey = useOdds((s) => s.hasKey);
  const quota = useOdds((s) => s.quota);
  const [val, setVal] = useState('');
  const [msg, setMsg] = useState<string>();
  useEffect(() => { void getSecret('oddsapi').then((k) => useOdds.setState({ hasKey: !!k })); }, []);
  const save = async (v: string | null) => {
    const ok = await setSecret('oddsapi', v);
    setMsg(ok ? (v ? 'Saved.' : 'Removed.') : 'Could not save the key.');
    setVal('');
    useOdds.setState({ hasKey: !!v && ok, error: undefined });
    if (v && ok) void useOdds.getState().refresh(useApp.getState().leagues, Object.values(useApp.getState().games));
  };
  return (
    <section className="panel">
      <h3 className="sectionTitle"><KeyRound /> ODDS FROM EVERY SPORTSBOOK</h3>
      <p className="muted">
        Multi-book odds (FanDuel, DraftKings, BetMGM, Caesars, BetRivers and more) come from <b>The Odds API</b>. Its free plan gives 500 credits a month;
        each league refresh costs {CREDITS_PER_REFRESH} credits, so Dial TV caches every response and only refreshes leagues with games in the next 24 hours.
        Without a key you still get ESPN’s single line for each game.
      </p>
      <ol className="muted small steps">
        <li>Open <button className="link" onClick={() => openExternal(ODDS_API_SIGNUP)}>the-odds-api.com <ExternalLink /></button> and choose the free plan (email only).</li>
        <li>Copy the API key from the email and paste it here.</li>
      </ol>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (val.trim()) void save(val.trim()); }}>
        <input className="field" type="password" autoComplete="off" aria-label="Odds API key" placeholder={hasKey ? 'Key saved — paste a new one to replace it' : 'Paste your Odds API key'} value={val} onChange={(e) => setVal(e.target.value)} />
        <button className="primary" disabled={!val.trim()}>Save key</button>
        {hasKey && <button type="button" className="ghost danger" onClick={() => void save(null)}><Trash2 /> Remove</button>}
      </form>
      <p className="small muted"><Lock /> {secretsAreEncrypted() ? 'Stored encrypted with your operating system’s keychain.' : 'Web version: stored in this browser’s local storage — anyone using this browser profile could read it. The desktop app encrypts it with the OS keychain.'}</p>
      {msg && <p className="small">{msg}</p>}
      {quota && <p className="small">Credits left this month: <b>{quota.remaining ?? '?'}</b>{quota.used != null ? ` (used ${quota.used})` : ''} · checked {new Date(quota.at).toLocaleString()}</p>}
    </section>
  );
}

export function BetsSettings() {
  const s = useBets();
  const [dep, setDep] = useState('');
  const set = (p: Partial<typeof s>) => useBets.setState(p);
  const toggleBook = (k: string) => set({ books: s.books.includes(k) ? s.books.filter((x) => x !== k) : BOOKS.map((b) => b.key).filter((x) => x === k || s.books.includes(x)) });
  const takeBreak = (days: number) => {
    if (confirm(`Hide Bets for ${days} day${days > 1 ? 's' : ''}? You can end the break early from this page.`)) set({ breakUntil: Date.now() + days * 86400e3 });
  };

  return (
    <div className="betsSettings">
      <ApiKey />
      <section className="panel">
        <h3 className="sectionTitle">REFRESH</h3>
        <div className="row">
          <label className="lbl">Auto-refresh (leagues with games in the next 24 h, while Bets is open)
            <select className="field" value={s.autoRefreshMin} onChange={(e) => set({ autoRefreshMin: +e.target.value as 0 | 15 | 30 | 60 })}>
              <option value={0}>Off — refresh by hand</option><option value={15}>Every 15 min</option><option value={30}>Every 30 min</option><option value={60}>Every hour</option>
            </select>
          </label>
          <label className="lbl small">Keep in reserve (credits)<input className="field" type="number" min={0} value={s.reserveCredits} onChange={(e) => set({ reserveCredits: Math.max(0, +e.target.value) })} /></label>
        </div>
        <h3 className="sectionTitle">BOOKS ON THE BOARD</h3>
        <div className="chips">{BOOKS.map((b) => <button key={b.key} className={s.books.includes(b.key) ? 'on' : ''} aria-pressed={s.books.includes(b.key)} onClick={() => toggleBook(b.key)}>{b.title}</button>)}</div>
      </section>
      <section className="panel">
        <h3 className="sectionTitle">BANKROLL</h3>
        <div className="row">
          <label className="lbl small">Starting bankroll ($)<input className="field" aria-label="Starting bankroll" type="number" min={0} value={s.bankrollStart} onChange={(e) => set({ bankrollStart: Math.max(0, +e.target.value) })} /></label>
          <label className="lbl small">Deposit (+) / withdraw (−)<input className="field" aria-label="Deposit or withdraw" type="number" value={dep} onChange={(e) => setDep(e.target.value)} /></label>
          <button className="ghost" disabled={!+dep} onClick={() => { set({ bankroll: [...s.bankroll, { id: uid(), at: Date.now(), amount: +dep }] }); setDep(''); }}>Add</button>
        </div>
        {s.bankroll.length > 0 && (
          <div className="small muted">{s.bankroll.slice(-5).map((b) => <div key={b.id}>{new Date(b.at).toLocaleDateString()} · {fmtMoney(b.amount, true)} <button className="icon" aria-label="Remove" onClick={() => set({ bankroll: s.bankroll.filter((x) => x.id !== b.id) })}><Trash2 /></button></div>)}</div>
        )}
      </section>
      <section className="panel">
        <h3 className="sectionTitle">LIMITS</h3>
        <p className="muted small">Optional. Dial TV shows a reminder when you go past them — it can’t stop a sportsbook from taking a bet. Most books also let you set deposit and wager limits in your account.</p>
        <div className="row">
          <label className="lbl small">Weekly loss limit ($)<input className="field" aria-label="Weekly loss limit" type="number" min={0} value={s.limits.weeklyLoss ?? ''} onChange={(e) => set({ limits: { ...s.limits, weeklyLoss: e.target.value === '' ? undefined : +e.target.value } })} /></label>
          <label className="lbl small">Max stake per bet ($)<input className="field" aria-label="Max stake per bet" type="number" min={0} value={s.limits.maxStake ?? ''} onChange={(e) => set({ limits: { ...s.limits, maxStake: e.target.value === '' ? undefined : +e.target.value } })} /></label>
        </div>
        <h3 className="sectionTitle"><PauseCircle /> TAKE A BREAK</h3>
        <p className="muted small">Hides odds and the tracker (and the Bets panel on Game Day) for a while.</p>
        <div className="row">{[1, 7, 30].map((d) => <button key={d} className="ghost" onClick={() => takeBreak(d)}>{d === 1 ? '24 hours' : `${d} days`}</button>)}</div>
      </section>
    </div>
  );
}
