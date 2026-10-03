import { create } from 'zustand';
import type { League, SportEvent } from '../types';
import { createPersisted } from './persisted';
import { gradeBets, type Bet } from '../lib/sports';
import {
  cachedOdds, DEFAULT_BOOKS, espnOddsEvent, fetchLeagueOdds, leaguesDue, matchGame, ODDS_UNSUPPORTED, pushSnapshot, snapshotOf,
  type LineSnapshot, type OddsEvent,
} from '../providers/oddsapi';
import { getSecret } from '../lib/secrets';
import { useApp } from './app';

export type { Bet, BetLeg } from '../lib/sports';

export interface BankrollEntry {
  id: string;
  at: number;
  /** + deposit, − withdrawal */
  amount: number;
  note?: string;
}

export interface BetsData {
  bets: Bet[];
  /** Starting bankroll; balance = start + deposits/withdrawals + settled P/L − open stakes. */
  bankrollStart: number;
  bankroll: BankrollEntry[];
  limits: { weeklyLoss?: number; maxStake?: number };
  /** "Take a break": Bets is hidden until this time (ms). */
  breakUntil?: number;
  /** Books shown as columns on the odds board, in order. */
  books: string[];
  /** Auto-refresh interval for Odds API leagues with games in the next 24 h (0 = manual only). */
  autoRefreshMin: 0 | 15 | 30 | 60;
  /** Stop auto-refresh when fewer credits than this remain. */
  reserveCredits: number;
}

export const BETS_VERSION = 1;

export const defaultBets = (): BetsData => ({
  bets: [],
  bankrollStart: 0,
  bankroll: [],
  limits: {},
  books: DEFAULT_BOOKS,
  autoRefreshMin: 15,
  reserveCredits: 50,
});

/** Real bets the user placed at sportsbooks (tracking only — nothing is ever sent to a book). */
export const useBets = createPersisted<BetsData>({
  key: 'bets',
  version: BETS_VERSION,
  defaults: defaultBets,
  migrate: (stored) => ({ ...defaultBets(), ...(stored && typeof stored === 'object' ? (stored as Partial<BetsData>) : {}) }),
});

export const onBreak = (s: Pick<BetsData, 'breakUntil'>, now = Date.now()) => !!s.breakUntil && s.breakUntil > now;

/** Grade open bets against the latest scores (called by the engine after every poll). */
export function gradeOpenBets(games: Record<string, SportEvent>) {
  const s = useBets.getState();
  if (!s.hydrated || !s.bets.some((b) => b.status === 'open')) return;
  const next = gradeBets(s.bets, games);
  if (next !== s.bets) useBets.setState({ bets: next });
}

// Grade as soon as saved bets load and whenever bets change (a bet added for a game that is already final).
void useBets.ready.then(() => {
  gradeOpenBets(useApp.getState().games);
  useBets.subscribe((st, prev) => {
    if (st.bets !== prev.bets) gradeOpenBets(useApp.getState().games);
  });
});

/** Open legs whose game must still be fetched to grade them. */
export function openLegs(): { eventId: string; league: League; start?: number; result?: string }[] {
  const out: { eventId: string; league: League; start?: number; result?: string }[] = [];
  for (const b of useBets.getState().bets) {
    if (b.status !== 'open' || b.manual) continue;
    for (const l of b.legs) if (l.eventId && !l.result) out.push({ eventId: l.eventId, league: l.league, start: l.start });
  }
  return out;
}

// ---------- Line history (consensus snapshots per game) ----------

export const useLineHistory = createPersisted<{ lines: Record<string, LineSnapshot[]> }>({
  key: 'oddsHistory',
  version: 1,
  defaults: () => ({ lines: {} }),
});

function recordLines(pairs: { key: string; ev: OddsEvent }[], now = Date.now()) {
  const st = useLineHistory.getState();
  if (!st.hydrated) return;
  let lines = st.lines;
  for (const { key, ev } of pairs) {
    const next = pushSnapshot(lines[key], snapshotOf(ev, now));
    if (next !== lines[key]) lines = { ...lines, [key]: next };
  }
  // Forget games that started more than 3 days ago.
  for (const [k, v] of Object.entries(lines)) {
    const ev = pairs.find((p) => p.key === k)?.ev;
    if (!ev && v.length && now - v[v.length - 1].at > 3 * 86400e3) {
      if (lines === st.lines) lines = { ...lines };
      delete lines[k];
    }
  }
  if (lines !== st.lines) useLineHistory.setState({ lines });
}

/** Record ESPN's single-book line movement too (works without an API key). */
export function recordEspnLines(games: SportEvent[]) {
  const pairs = games.filter((g) => g.state === 'pre' && g.odds).map((g) => ({ key: `espn:${g.id}`, ev: espnOddsEvent(g)! })).filter((p) => p.ev);
  if (pairs.length) recordLines(pairs);
}

// ---------- Odds (runtime) ----------

interface OddsState {
  /** League → events from The Odds API (cached). */
  events: Partial<Record<League, OddsEvent[]>>;
  fetchedAt: Partial<Record<League, number>>;
  quota?: { remaining?: number; used?: number; at: number };
  hasKey: boolean;
  loading: boolean;
  error?: string;
  /** Load cached responses + whether a key is set. */
  init: (leagues: League[]) => Promise<void>;
  /** Fetch leagues from the API (3 credits each). */
  refresh: (leagues: League[], games: SportEvent[]) => Promise<void>;
  /** Timer tick: refresh only leagues that are due (games in the next 24 h, stale cache, enough credits). */
  autoRefresh: (leagues: League[], games: SportEvent[]) => Promise<void>;
}

export const useOdds = create<OddsState>((set, get) => ({
  events: {},
  fetchedAt: {},
  hasKey: false,
  loading: false,

  init: async (leagues) => {
    const key = await getSecret('oddsapi');
    set({ hasKey: !!key });
    const loaded = await Promise.all(leagues.map((l) => cachedOdds(l)));
    const events = { ...get().events };
    const fetchedAt = { ...get().fetchedAt };
    let quota = get().quota;
    for (const c of loaded) {
      if (!c || (fetchedAt[c.league] ?? 0) >= c.at) continue;
      events[c.league] = c.events;
      fetchedAt[c.league] = c.at;
      if (c.remaining != null && (!quota || c.at > quota.at)) quota = { remaining: c.remaining, used: c.used, at: c.at };
    }
    set({ events, fetchedAt, quota });
  },

  refresh: async (leagues, games) => {
    const key = await getSecret('oddsapi');
    if (!key) {
      set({ hasKey: false, error: undefined });
      return;
    }
    const todo = leagues.filter((l) => !ODDS_UNSUPPORTED.has(l));
    if (!todo.length || get().loading) return;
    set({ loading: true, error: undefined, hasKey: true });
    const errors: string[] = [];
    for (const l of todo) {
      try {
        const r = await fetchLeagueOdds(l, key);
        set((s) => ({
          events: { ...s.events, [l]: r.events },
          fetchedAt: { ...s.fetchedAt, [l]: r.at },
          quota: r.remaining != null ? { remaining: r.remaining, used: r.used, at: r.at } : s.quota,
        }));
        recordLines(r.events.map((ev) => ({ key: matchGame(ev, games)?.id ?? `oddsapi:${ev.id}`, ev })));
      } catch (e) {
        const err = e as Error & { status?: number; remaining?: number; used?: number };
        errors.push(err.message);
        if (err.remaining != null) set({ quota: { remaining: err.remaining, used: err.used, at: Date.now() } });
        if (err.status === 401 || err.status === 429) break; // no point trying other leagues
      }
    }
    set({ loading: false, error: errors.length ? errors[0] : undefined });
  },

  autoRefresh: async (leagues, games) => {
    const s = get();
    const prefs = useBets.getState();
    if (!s.hasKey || s.loading || onBreak(prefs)) return;
    if (s.quota?.remaining != null && s.quota.remaining < prefs.reserveCredits) return;
    const due = leaguesDue(Date.now(), leagues, games, s.fetchedAt, prefs.autoRefreshMin);
    if (due.length) await s.refresh(due, games);
  },
}));
