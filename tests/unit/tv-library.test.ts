import { describe, expect, it } from 'vitest';
import { buildLibrary, episodeName, nextEpisode } from '../../src/components/tv/library';
import { upNextEpisode } from '../../src/components/tv/Details';
import type { Channel } from '../../src/types';

const ep = (show: string, s: number, e: number, extra = ''): Channel => ({
  id: `${show}-${s}-${e}`, number: 1, name: `${show} S${s}E${e}${extra}`, group: 'Series', mark: 'XX', url: 'http://h/x.mkv', sourceId: 's',
  kind: 'series', title: `${show} S0${s}E0${e}${extra}`, series: { show, season: s, episode: e },
});
const movie = (i: number): Channel => ({ id: `m${i}`, number: 1, name: `Movie ${i}`, group: `G${i % 20}`, mark: 'MV', url: `http://h/m${i}.mp4`, sourceId: 's', kind: 'movie', title: `Movie ${i}`, year: 1950 + (i % 70) });

describe('VOD library', () => {
  it('groups episodes by show and season in watch order', () => {
    const lib = buildLibrary([ep('Lost', 2, 1), ep('Lost', 1, 2), ep('Lost', 1, 1), ep('Dark', 1, 1)]);
    expect(lib.shows.map((s) => s.name)).toEqual(['Lost', 'Dark']);
    const lost = lib.showByKey.get('show:lost')!;
    expect(lost.seasons.map((s) => [s.season, s.episodes.length])).toEqual([[1, 2], [2, 1]]);
    expect(lost.episodes.map((e) => e.id)).toEqual(['Lost-1-1', 'Lost-1-2', 'Lost-2-1']);
    expect(nextEpisode(lib, 'Lost-1-2')?.id).toBe('Lost-2-1');
    expect(nextEpisode(lib, 'Lost-2-1')).toBeUndefined();
  });

  it('offers the in-progress episode, else the one after the last watched', () => {
    const lib = buildLibrary([ep('Lost', 1, 1), ep('Lost', 1, 2), ep('Lost', 1, 3)]);
    const show = lib.shows[0];
    expect(upNextEpisode(show, {})?.id).toBe('Lost-1-1');
    expect(upNextEpisode(show, { 'Lost-1-1': { pos: 100, dur: 100, at: 1, watched: true } })?.id).toBe('Lost-1-2');
    expect(upNextEpisode(show, { 'Lost-1-3': { pos: 300, dur: 2000, at: 2 } })?.id).toBe('Lost-1-3');
  });

  it('names episodes without repeating the show', () => {
    expect(episodeName(ep('Lost', 1, 2))).toBe('Episode 2');
    expect(episodeName(ep('Lost', 1, 2, ' - Pilot Part 2'))).toBe('Pilot Part 2');
  });

  it('stays fast with 50k+ items (memoized per channels array)', () => {
    const chans: Channel[] = [];
    for (let i = 0; i < 40_000; i++) chans.push(movie(i));
    for (let s = 0; s < 500; s++) for (let e = 1; e <= 30; e++) chans.push(ep(`Show ${s}`, 1 + (e % 3), e));
    const t0 = performance.now();
    const lib = buildLibrary(chans);
    const took = performance.now() - t0;
    expect(lib.movies).toHaveLength(40_000);
    expect(lib.shows).toHaveLength(500);
    expect(took).toBeLessThan(1500);
    expect(buildLibrary(chans)).toBe(lib);
  });
});
