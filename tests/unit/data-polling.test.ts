import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, pollSports, resetPollState } from '../../src/hooks/useEngine';
import { defaultPersisted, useApp } from '../../src/store/app';
import { ymd } from '../../src/providers/espn';

const ev = (id: string, date: string, state: 'pre' | 'in' | 'post') => ({
  id, date,
  status: { type: { state, completed: state === 'post', name: state === 'in' ? 'STATUS_IN_PROGRESS' : 'STATUS_SCHEDULED' }, period: 4, clock: 100 },
  competitions: [{ competitors: [{ homeAway: 'home', score: '90', team: { id: '1', abbreviation: 'NYK' } }, { homeAway: 'away', score: '88', team: { id: '2', abbreviation: 'BOS' } }] }],
});

let calls: string[] = [];
let offline = false;
let yesterday = '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 0, 30)); // 00:30 local, just after midnight
  yesterday = ymd(new Date(2026, 9, 3, 12));
  resetPollState();
  calls = [];
  offline = false;
  useApp.setState({ ...defaultPersisted(), leagues: ['nba'], games: {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (offline) throw new TypeError('Failed to fetch');
    const dates = /dates=(\d+)/.exec(url)![1];
    const events = dates === yesterday ? [ev('7', new Date(2026, 9, 3, 22).toISOString(), 'in')] : [];
    return new Response(JSON.stringify({ events }), { status: 200 });
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe('sports polling', () => {
  it('keeps polling a live game from yesterday at 30s after local midnight', async () => {
    await pollSports(true);
    expect(calls.length).toBe(8); // yesterday, today, 6 ahead
    expect(useApp.getState().games['nba:7']?.state).toBe('in');
    calls = [];
    advance(31_000);
    await pollSports();
    expect(calls.map((u) => /dates=(\d+)/.exec(u)![1])).toEqual([yesterday]);
  });

  it('forced polls right after each other (StrictMode) do not double-fetch', async () => {
    await Promise.all([pollSports(true), pollSports(true)]);
    expect(calls.length).toBe(8);
    await pollSports(true);
    expect(calls.length).toBe(8);
  });

  it('backs off when offline instead of retrying every tick', async () => {
    offline = true;
    await pollSports(true);
    expect(calls.length).toBe(8);
    expect(useApp.getState().sportsError).toMatch(/unavailable/);
    calls = [];
    advance(10_000);
    await pollSports();
    expect(calls.length).toBe(0);
    advance(6_000); // 16s: first backoff (15s) elapsed
    await pollSports();
    expect(calls.length).toBe(8);
    calls = [];
    advance(20_000); // second backoff is 30s
    await pollSports();
    expect(calls.length).toBe(0);
    expect(backoffMs(2)).toBe(30_000);
  });

  it('an older response never overwrites newer game data', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const dates = /dates=(\d+)/.exec(url)![1];
      if (dates !== yesterday) return new Response(JSON.stringify({ events: [] }));
      const mine = ++n;
      if (mine === 1) await gate; // first (older) request is slow
      const e = ev('7', new Date(2026, 9, 3, 22).toISOString(), mine === 1 ? 'in' : 'post');
      return new Response(JSON.stringify({ events: [e] }));
    }));
    const slow = pollSports(true);
    // The slow request has started. Simulate an overlapping newer request for the same key.
    await Promise.resolve();
    advance(11_000);
    resetPollState(); // clear the in-flight flag so a second request for the key starts
    await pollSports(true);
    expect(useApp.getState().games['nba:7'].state).toBe('post');
    release();
    await slow;
    // The slow response started earlier, so it must not replace the newer "post" data.
    expect(useApp.getState().games['nba:7'].state).toBe('post');
  });
});
