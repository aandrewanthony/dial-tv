import { describe, expect, it } from 'vitest';
import { applyRules, findConflicts, HOUR, layoutLanes, MIN, snap, startOfDay } from '../../src/lib/scheduler';
import type { ScheduleEntry, SportEvent } from '../../src/types';
import { generateFixtureGuide, DEMO_CHANNELS } from '../../src/providers/demo';

const e = (id: string, startH: number, endH: number): ScheduleEntry => ({ id, title: id, start: startH * HOUR, end: endH * HOUR });

describe('conflicts', () => {
  it('detects overlaps but not back-to-back entries', () => {
    const c = findConflicts([e('a', 19, 21), e('b', 20, 22), e('c', 22, 23), e('d', 18, 19)]);
    expect(c.get('a')).toEqual(['b']);
    expect(c.get('b')).toEqual(['a']);
    expect(c.has('c')).toBe(false);
    expect(c.has('d')).toBe(false);
  });

  it('lays out overlapping entries in lanes', () => {
    const l = layoutLanes([e('a', 19, 21), e('b', 20, 22), e('c', 20.5, 21.5), e('d', 23, 24)]);
    expect(l.get('a')).toEqual({ lane: 0, lanes: 3 });
    expect(l.get('b')).toEqual({ lane: 1, lanes: 3 });
    expect(l.get('c')).toEqual({ lane: 2, lanes: 3 });
    expect(l.get('d')).toEqual({ lane: 0, lanes: 1 });
  });

  it('reuses a freed lane', () => {
    const l = layoutLanes([e('a', 19, 20), e('b', 19.5, 21), e('c', 20, 21)]);
    expect(l.get('c')!.lane).toBe(0);
    expect(l.get('c')!.lanes).toBe(2);
  });

  it('snaps to 15 minutes', () => {
    expect(snap(7 * MIN)).toBe(0);
    expect(snap(8 * MIN)).toBe(15 * MIN);
    expect(snap(-8 * MIN)).toBe(-15 * MIN);
  });
});

const game = (id: string, home: string, away: string, start: number, state: SportEvent['state'] = 'pre'): SportEvent => ({
  id, league: 'nfl', start, state, statusText: '', period: 0, broadcasts: ['CBS'],
  home: { id: home, abbr: home, name: home, shortName: home }, away: { id: away, abbr: away, name: away, shortName: away },
});

describe('rules', () => {
  const from = startOfDay(Date.UTC(2026, 9, 3, 12));
  it('team rules add every upcoming game with deterministic ids', () => {
    const games = [game('nfl:1', 'CHI', 'NYJ', from + 13 * HOUR), game('nfl:2', 'BUF', 'NE', from + 13 * HOUR), game('nfl:3', 'NYJ', 'MIA', from - HOUR, 'post')];
    const out = applyRules([{ id: 'r', kind: 'team', match: 'nfl:NYJ', enabled: true, reminderMin: 15 }], { games, programs: [], from, to: from + 7 * 24 * HOUR });
    expect(out.map((x) => x.id)).toEqual(['game:nfl:1']);
    expect(out[0]).toMatchObject({ ruleId: 'r', reminderMin: 15, end: from + 13 * HOUR + 3.25 * HOUR });
  });

  it('title rules match case-insensitively; disabled rules do nothing', () => {
    const programs = [{ id: 'p1', channelId: 'c', title: 'SportsCenter', start: from + HOUR, end: from + 2 * HOUR, category: 'Sports' }];
    expect(applyRules([{ id: 't', kind: 'title', match: 'sportscenter', enabled: true }], { games: [], programs, from, to: from + 24 * HOUR })).toHaveLength(1);
    expect(applyRules([{ id: 't', kind: 'title', match: 'sportscenter', enabled: false }], { games: [], programs, from, to: from + 24 * HOUR })).toHaveLength(0);
  });

  it('block rules respect weekdays and cross-midnight ranges', () => {
    const out = applyRules([{ id: 'b', kind: 'block', match: 'Prime', enabled: true, days: [0], startMin: 22 * 60, endMin: 60 }], { games: [], programs: [], from, to: from + 7 * 24 * HOUR });
    expect(out).toHaveLength(1);
    expect(new Date(out[0].start).getDay()).toBe(0);
    expect(out[0].end - out[0].start).toBe(3 * HOUR);
  });
});

describe('seeded demo guide', () => {
  it('is deterministic for a given day regardless of time opened, and gapless', () => {
    const day = startOfDay(Date.UTC(2026, 9, 3, 15));
    const a = generateFixtureGuide(DEMO_CHANNELS, day + 3 * HOUR, 1);
    const b = generateFixtureGuide(DEMO_CHANNELS, day + 20 * HOUR, 1);
    expect(a).toEqual(b);
    const ch = a.filter((p) => p.channelId === DEMO_CHANNELS[0].id);
    for (let i = 1; i < ch.length; i++) expect(ch[i].start).toBe(ch[i - 1].end);
    expect(ch[0].start).toBe(day);
  });
});
