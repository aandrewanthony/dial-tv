import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, lockedSet, organizedChannels } from '../../src/store/app';
import type { Channel } from '../../src/types';

const ch = (id: string, name: string, tvgId = 'espn.us'): Channel =>
  ({ id, number: 1, name, group: 'US| SPORTS', mark: 'ES', url: `http://h/${id}.ts`, tvgId, sourceId: 'p1' });

describe('parental lock with merged duplicates', () => {
  const channels = [ch('p1:a', 'US| ESPN HD'), ch('p1:b', 'US| ESPN FHD'), ch('p1:c', 'US| ESPN 4K')];
  const base = { channels, channelOrder: [], hidden: [] };

  it('a lock saved on a duplicate also locks the merged channel', () => {
    const org = organizedChannels(base);
    const logical = org.alias.get('p1:c') ?? 'p1:c';
    expect(org.alias.get('p1:a') ?? 'p1:a').toBe(logical); // all three merged into one
    const s = { ...base, settings: { ...DEFAULT_SETTINGS, locked: ['p1:c'] } };
    expect(lockedSet(s).has(logical)).toBe(true);
    expect(lockedSet(s).has('p1:c')).toBe(true);
  });

  it('returns a stable set for the same inputs (safe as a store selector)', () => {
    const s = { ...base, settings: { ...DEFAULT_SETTINGS, locked: ['p1:a'] } };
    expect(lockedSet(s)).toBe(lockedSet(s));
  });
});
