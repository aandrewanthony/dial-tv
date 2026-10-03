import { describe, expect, it } from 'vitest';
import { applyRules, entryFromGame, HOUR, startOfDay } from '../../src/lib/scheduler';
import { mergeRuleEntries } from '../../src/hooks/useEngine';
import type { Program, ScheduleRule, SportEvent } from '../../src/types';

const from = startOfDay(Date.UTC(2026, 9, 3, 12));
const game = (start: number): SportEvent => ({
  id: 'nfl:1', league: 'nfl', start, state: 'pre', statusText: '', period: 0, broadcasts: [],
  home: { id: 'h', abbr: 'NYJ', name: 'Jets', shortName: 'Jets' }, away: { id: 'a', abbr: 'MIA', name: 'Dolphins', shortName: 'Dolphins' },
});
const prog = (ch: string, start: number, title = 'SportsCenter'): Program => ({ id: `${ch}|${start}`, channelId: ch, title, start, end: start + HOUR, category: '' });

describe('rule expansion', () => {
  it('dedupes by id across overlapping rules and title+start across channels', () => {
    const rules: ScheduleRule[] = [
      { id: 't1', kind: 'title', match: 'sports', enabled: true },
      { id: 't2', kind: 'title', match: 'center', enabled: true },
      { id: 'r1', kind: 'team', match: 'nfl:NYJ', enabled: true },
      { id: 'r2', kind: 'team', match: 'nfl:MIA', enabled: true },
    ];
    const programs = [prog('espn', from + HOUR), prog('espn-hd', from + HOUR), prog('espn', from + 3 * HOUR)];
    const out = applyRules(rules, { games: [game(from + 13 * HOUR)], programs, from, to: from + 24 * HOUR });
    const ids = out.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith('game:'))).toEqual(['game:nfl:1']);
    expect(out.filter((e) => e.programId).map((e) => e.start)).toEqual([from + HOUR, from + 3 * HOUR]);
  });

  it('merges new entries, skips dismissed, and moves rule game entries when the game time changes', () => {
    const old = entryFromGame(game(from + 13 * HOUR), 'r1');
    const manual = { ...entryFromGame({ ...game(from + 13 * HOUR), id: 'nfl:2' }), ruleId: undefined };
    const schedule = [old, manual];
    const moved = entryFromGame(game(from + 16 * HOUR), 'r1');
    const next = mergeRuleEntries(schedule, [moved, { ...manual, start: manual.start + HOUR, ruleId: 'r1' }], []);
    expect(next.find((e) => e.id === old.id)!.start).toBe(from + 16 * HOUR);
    expect(next.find((e) => e.id === manual.id)!.start).toBe(manual.start); // user-made entries untouched
    expect(mergeRuleEntries(next, [moved], [])).toBe(next); // no-op returns same array
    const add = entryFromGame({ ...game(from + 20 * HOUR), id: 'nfl:3' }, 'r1');
    expect(mergeRuleEntries(next, [add], [add.id])).toBe(next);
    expect(mergeRuleEntries(next, [add], []).map((e) => e.id)).toContain(add.id);
  });

  it('does not add a title-rule entry again when the same airing comes from another channel', () => {
    const [first] = applyRules([{ id: 't', kind: 'title', match: 'sports', enabled: true }], { games: [], programs: [prog('a', from + HOUR)], from, to: from + 24 * HOUR });
    const [second] = applyRules([{ id: 't', kind: 'title', match: 'sports', enabled: true }], { games: [], programs: [prog('b', from + HOUR)], from, to: from + 24 * HOUR });
    expect(first.id).not.toBe(second.id);
    const s = [first];
    expect(mergeRuleEntries(s, [second], [])).toBe(s);
  });
});
