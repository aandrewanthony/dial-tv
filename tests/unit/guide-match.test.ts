import { describe, expect, it } from 'vitest';
import { EpgMatcher, epgNameKey } from '../../src/workers/epgCore';

const epg = [
  { id: 'ESPN.us', names: ['ESPN'] },
  { id: 'espn2.us', names: ['ESPN 2'] },
  { id: 'skysportsmainevent.uk', names: ['Sky Sports Main Event'] },
  { id: 'cnn.us', names: ['CNN International', 'CNN'] },
  { id: 'nflnetwork.us', names: ['NFL Network'] },
];

describe('guide name keys', () => {
  it('strips country prefixes and quality tags', () => {
    expect(epgNameKey('US| ESPN FHD')).toBe('espn');
    expect(epgNameKey('[UK] Sky Sports Main Event HD')).toBe('sky sports main event');
    expect(epgNameKey('UK: Sky Sports Main Event 4K')).toBe('sky sports main event');
    expect(epgNameKey('LATINO| ESPN 2 HEVC')).toBe('espn 2');
    expect(epgNameKey('CA - TSN 1 720p')).toBe('tsn 1');
    expect(epgNameKey('ESPN (Backup)')).toBe('espn');
  });
});

describe('playlist channel → guide channel resolution', () => {
  const m = new EpgMatcher(epg);
  it('tvg-id exact, then case-insensitive', () => {
    expect(m.resolve({ id: 'a', name: 'whatever', tvgId: 'ESPN.us' })).toEqual({ key: 'ESPN.us', how: 'tvg-id' });
    expect(m.resolve({ id: 'b', name: 'whatever', tvgId: 'espn.US' })).toEqual({ key: 'ESPN.us', how: 'tvg-id' });
  });
  it('then display name, then normalized name', () => {
    expect(m.resolve({ id: 'c', name: 'cnn' })).toEqual({ key: 'cnn.us', how: 'name' });
    expect(m.resolve({ id: 'd', name: 'US| ESPN FHD' })).toEqual({ key: 'ESPN.us', how: 'similar' });
    expect(m.resolve({ id: 'e', name: 'UK: Sky Sports Main Event HD', tvgId: 'unknown' })).toEqual({ key: 'skysportsmainevent.uk', how: 'similar' });
    expect(m.resolve({ id: 'f', name: 'US| ESPN 2 HEVC' })?.key).toBe('espn2.us');
    expect(m.resolve({ id: 'g', name: 'Totally Unknown' })).toBeUndefined();
  });
  it('manual mapping wins', () => {
    expect(m.resolve({ id: 'a', name: 'ESPN', tvgId: 'ESPN.us' }, { a: 'nflnetwork.us' })).toEqual({ key: 'nflnetwork.us', how: 'manual' });
  });
  it('suggests close guide channels with a confidence', () => {
    const s = m.suggest({ id: 'x', name: 'US| NFL Network East Coast' });
    expect(s[0].key).toBe('nflnetwork.us');
    expect(s[0].confidence).toBeGreaterThan(0.4);
    // Different numbers are penalized: ESPN 2 isn't ESPN.
    const e = m.suggest({ id: 'y', name: 'ESPN 2 Alt' });
    expect(e[0].key).toBe('espn2.us');
    expect(m.suggest({ id: 'z', name: 'tvgid stem', tvgId: 'NFLNetwork.ca' })[0]).toMatchObject({ key: 'nflnetwork.us', confidence: 0.85 });
  });
});
