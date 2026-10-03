import { useEffect, useState } from 'react';
import { AlertTriangle, Layers, Loader2, PauseCircle, RefreshCw, Settings2, Ticket, TrendingUp } from 'lucide-react';
import { useApp } from '../store/app';
import { onBreak, useBets, useOdds } from '../store/bets';
import { CREDITS_PER_REFRESH, ODDS_UNSUPPORTED } from '../providers/oddsapi';
import { fmtMoney, weekLoss, type BetLeg } from '../lib/sports';
import { OddsBoard } from '../components/sports/OddsBoard';
import { AddBetModal, BetTracker } from '../components/sports/BetTracker';
import { ParlayCalc } from '../components/sports/ParlayCalc';
import { BetsSettings } from '../components/sports/BetsSettings';
import { useSlip } from '../components/sports/betsUi';

type Tab = 'odds' | 'bets' | 'parlay' | 'settings';

/** Footer shown everywhere on Bets. Informational, not preachy. */
export function GamblerLine() {
  return <p className="gamblerLine">21+. Gambling problem? Call or text <b>1-800-GAMBLER</b>. Dial TV only shows odds and tracks bets you place yourself.</p>;
}

export default function BetsPage() {
  const leagues = useApp((s) => s.leagues);
  const games = useApp((s) => s.games);
  const hydrated = useBets((s) => s.hydrated);
  const breakUntil = useBets((s) => s.breakUntil);
  const bets = useBets((s) => s.bets);
  const limits = useBets((s) => s.limits);
  const { hasKey, loading, error, quota, fetchedAt } = useOdds();
  const slipCount = useSlip((s) => s.legs.length);
  const [tab, setTab] = useState<Tab>('odds');
  const [adding, setAdding] = useState<{ legs?: (BetLeg & { book?: string })[]; book?: string } | null>(null);

  // Load cached odds, then refresh what's due; keep checking on a slow timer while the page is open.
  useEffect(() => {
    let stop = false;
    void useOdds.getState().init(useApp.getState().leagues).then(() => {
      if (!stop) void useOdds.getState().autoRefresh(useApp.getState().leagues, Object.values(useApp.getState().games));
    });
    const t = setInterval(() => void useOdds.getState().autoRefresh(useApp.getState().leagues, Object.values(useApp.getState().games)), 60_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  if (!hydrated) return <div className="loadingPage">Loading…</div>;

  if (onBreak({ breakUntil })) {
    return (
      <div className="betsPage">
        <div className="panel breakPanel">
          <PauseCircle className="big" />
          <h2>Taking a break</h2>
          <p className="muted">Bets is hidden until {new Date(breakUntil!).toLocaleString()}. Your tracked bets are kept.</p>
          <button className="ghost" onClick={() => { if (confirm('End your break now?')) useBets.setState({ breakUntil: undefined }); }}>End break early</button>
        </div>
        <GamblerLine />
      </div>
    );
  }

  const lost = weekLoss(bets);
  const overLoss = limits.weeklyLoss != null && limits.weeklyLoss > 0 && lost >= limits.weeklyLoss;
  const refreshable = leagues.filter((l) => !ODDS_UNSUPPORTED.has(l));
  const last = Math.max(0, ...Object.values(fetchedAt).map((x) => x ?? 0));
  const track = (legs: (BetLeg & { book?: string })[], book?: string) => setAdding({ legs, book });

  return (
    <div className="betsPage">
      {overLoss && (
        <div className="banner warn" role="alert"><AlertTriangle /> You’re down {fmtMoney(lost)} this week — past your {fmtMoney(limits.weeklyLoss!)} weekly limit. Maybe sit the rest of this week out?</div>
      )}
      <div className="guideBar">
        <div className="chips" role="tablist">
          <button role="tab" aria-selected={tab === 'odds'} className={tab === 'odds' ? 'on' : ''} onClick={() => setTab('odds')}><TrendingUp /> Odds board</button>
          <button role="tab" aria-selected={tab === 'bets'} className={tab === 'bets' ? 'on' : ''} onClick={() => setTab('bets')}><Ticket /> My bets{bets.some((b) => b.status === 'open') ? ` (${bets.filter((b) => b.status === 'open').length})` : ''}</button>
          <button role="tab" aria-selected={tab === 'parlay'} className={tab === 'parlay' ? 'on' : ''} onClick={() => setTab('parlay')}><Layers /> Parlay calc{slipCount ? ` (${slipCount})` : ''}</button>
          <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}><Settings2 /> Settings</button>
        </div>
        {tab === 'odds' && (
          <div className="chips">
            {hasKey ? (
              <>
                <span className="muted small">{quota?.remaining != null ? `${quota.remaining} credits left` : ''}{last ? ` · updated ${new Date(last).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
                <button title={`Refresh all leagues now (${refreshable.length * CREDITS_PER_REFRESH} credits)`} disabled={loading} onClick={() => void useOdds.getState().refresh(refreshable, Object.values(games))}>
                  {loading ? <Loader2 className="spin" /> : <RefreshCw />} Refresh odds
                </button>
              </>
            ) : (
              <button onClick={() => setTab('settings')}>Add an Odds API key for every sportsbook</button>
            )}
          </div>
        )}
      </div>
      {error && tab === 'odds' && <div className="banner warn">{error}</div>}
      {tab === 'odds' && !hasKey && <div className="banner">Showing ESPN’s line for each game. Add a free Odds API key in Settings to compare FanDuel, DraftKings, BetMGM, Caesars and more side by side.</div>}

      {tab === 'odds' && <OddsBoard onTrack={track} />}
      {tab === 'bets' && <BetTracker onAdd={() => setAdding({})} />}
      {tab === 'parlay' && <ParlayCalc onTrack={track} />}
      {tab === 'settings' && <BetsSettings />}
      <GamblerLine />
      {adding && <AddBetModal initial={adding.legs} initialBook={adding.book} onClose={(saved) => { setAdding(null); if (saved) setTab('bets'); }} />}
    </div>
  );
}
