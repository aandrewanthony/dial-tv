import { describe, expect, it } from 'vitest';
import {
  advance, durationSec, editChannel, EST_EPISODE_SEC, EST_MOVIE_SEC, listings, nextNumber, orderedItems, rebase, seededShuffle, slotAt,
  type PersonalChannel, type PersonalItem,
} from '../../src/lib/personalSchedule';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const item = (id: string, kind: PersonalItem['kind'] = 'series'): PersonalItem => ({ id, kind, title: id });
const chan = (items: PersonalItem[], extra: Partial<PersonalChannel> = {}): PersonalChannel => ({
  id: 'c', name: 'C', number: 900, color: '#f00', items, order: 'sequential', seed: 1, anchor: { at: T0, index: 0 }, createdAt: T0, ...extra,
});

describe('personal schedule', () => {
  const ch = chan([item('a'), item('b'), item('c')]);
  const known = { a: 30 * 60, b: 20 * 60, c: 10 * 60 }; // 60-minute loop

  it('finds the item on air at time T and the offset into it', () => {
    expect(slotAt(ch, known, T0)).toMatchObject({ index: 0, offset: 0, start: T0, end: T0 + 30 * MIN });
    expect(slotAt(ch, known, T0 + 31 * MIN)).toMatchObject({ index: 1, offset: 60, start: T0 + 30 * MIN });
    expect(slotAt(ch, known, T0 + 55 * MIN)).toMatchObject({ index: 2, offset: 5 * 60 });
  });

  it('loops forever, forward and backward in time', () => {
    expect(slotAt(ch, known, T0 + 24 * 60 * MIN + 31 * MIN)).toMatchObject({ index: 1, offset: 60 });
    // 5 minutes before the anchor = 5 minutes before the end of the loop (item c).
    expect(slotAt(ch, known, T0 - 5 * MIN)).toMatchObject({ index: 2, offset: 5 * 60, end: T0 });
  });

  it('estimates unknown durations (movie 100 min, episode 45 min)', () => {
    expect(durationSec(item('x', 'movie'), {})).toBe(EST_MOVIE_SEC);
    expect(durationSec(item('x', 'series'), {})).toBe(EST_EPISODE_SEC);
    expect(durationSec(item('x', 'series'), { x: 5 })).toBe(EST_EPISODE_SEC); // bogus tiny duration ignored
    const m = chan([item('m', 'movie'), item('e')]);
    expect(slotAt(m, {}, T0 + 101 * MIN)).toMatchObject({ index: 1, offset: 60 });
  });

  it('lists programs back to back across a window', () => {
    const l = listings(ch, known, T0 + 10 * MIN, T0 + 130 * MIN);
    expect(l.map((s) => s.item.id)).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a']);
    for (let i = 1; i < l.length; i++) expect(l[i].start).toBe(l[i - 1].end);
    expect(l[0].start).toBe(T0);
  });

  it('shuffle is stable for a seed and changes with the seed', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`i${i}`));
    const a = seededShuffle(items, 42).map((x) => x.id);
    expect(seededShuffle(items, 42).map((x) => x.id)).toEqual(a);
    expect(seededShuffle(items, 43).map((x) => x.id)).not.toEqual(a);
    expect([...a].sort()).toEqual(items.map((x) => x.id).sort());
    const s = chan(items, { order: 'shuffle', seed: 42 });
    expect(orderedItems(s).map((x) => x.id)).toEqual(a);
    expect(slotAt(s, {}, T0)!.item.id).toBe(a[0]);
  });

  it('a learned duration corrects the future without moving what is on now', () => {
    const est = {}; // all 45-min estimates
    const now = T0 + 50 * MIN; // inside item b (45..90)
    const before = slotAt(ch, est, now)!;
    expect(before).toMatchObject({ index: 1, offset: 5 * 60 });
    // We learn item a is really 20 minutes: without rebasing, "now" would jump.
    const learned = { a: 20 * 60 };
    expect(slotAt(ch, learned, now)!.offset).toBe(30 * 60);
    const rebased = { ...ch, anchor: rebase(ch, est, now) };
    expect(slotAt(rebased, learned, now)).toMatchObject({ index: 1, offset: 5 * 60 });
    // Learning the CURRENT item's duration moves its end (and everything after it).
    const learnedB = { b: 10 * 60 };
    const rb = { ...ch, anchor: rebase(ch, est, now) };
    expect(slotAt(rb, learnedB, now)).toMatchObject({ index: 1, offset: 5 * 60, end: T0 + 55 * MIN });
    expect(slotAt(rb, learnedB, T0 + 56 * MIN)!.index).toBe(2);
  });

  it('ending early starts the next item now', () => {
    const now = T0 + 12 * MIN;
    const next = { ...ch, anchor: advance(ch, known, now) };
    expect(slotAt(next, known, now)).toMatchObject({ index: 1, offset: 0, start: now });
  });

  it('editing keeps the current item on air', () => {
    const now = T0 + 40 * MIN; // b, 10 min in
    const edited = editChannel(ch, { items: [item('z'), ...ch.items] }, known, now);
    expect(slotAt(edited, known, now)).toMatchObject({ offset: 10 * 60 });
    expect(slotAt(edited, known, now)!.item.id).toBe('b');
    const removed = editChannel(ch, { items: [item('a'), item('c')] }, known, now);
    expect(slotAt(removed, known, now)).toMatchObject({ offset: 0 });
    const shuffled = editChannel(ch, { order: 'shuffle', seed: 7 }, known, now);
    expect(slotAt(shuffled, known, now)!.item.id).toBe('b');
    expect(slotAt(editChannel(ch, { items: [] }, known, now), known, now)).toBeUndefined();
  });

  it('picks channel numbers from 900', () => {
    expect(nextNumber([])).toBe(900);
    expect(nextNumber([900, 901, 903])).toBe(902);
  });
});
