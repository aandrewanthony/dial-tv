import { describe, expect, it } from 'vitest';
import { classifyContent } from '../../src/lib/content';
import { parseM3U } from '../../src/lib/m3u';

const c = (name: string, url: string, group?: string, type?: string) => classifyContent({ name, url, group, type });

describe('classifyContent', () => {
  it('uses Xtream URL paths', () => {
    expect(c('ESPN', 'http://h:8080/live/u/p/1.ts').kind).toBe('live');
    expect(c('Inception (2010)', 'http://h:8080/movie/u/p/2.mkv')).toEqual({ kind: 'movie', title: 'Inception', year: 2010 });
    const s = c('Breaking Bad S01E02', 'http://h:8080/series/u/p/3.mp4');
    expect(s.kind).toBe('series');
    expect(s.series).toEqual({ show: 'Breaking Bad', season: 1, episode: 2 });
    // An episode filed under /movie/ is still an episode.
    expect(c('Lost S02E05', 'http://h/movie/u/p/9.mp4').kind).toBe('series');
  });

  it('honors tvg-type', () => {
    expect(c('Something', 'http://h/x.mp4', '', 'live').kind).toBe('live');
    expect(c('Something', 'http://h/stream', '', 'movie').kind).toBe('movie');
    expect(c('Show S01E01', 'http://h/stream', '', 'series').kind).toBe('series');
    expect(c('Something', 'http://h/stream', '', 'vod').kind).toBe('movie');
  });

  it('parses episode markers in several notations', () => {
    expect(c('The Office S03E11', 'http://h/a.mp4').series).toEqual({ show: 'The Office', season: 3, episode: 11 });
    expect(c('Friends 1x02', 'http://h/a.mkv').series).toEqual({ show: 'Friends', season: 1, episode: 2 });
    expect(c('Seinfeld Season 4 Episode 7', 'http://h/a.mp4').series).toEqual({ show: 'Seinfeld', season: 4, episode: 7 });
    expect(c('La Casa de Papel Temporada 2 Episodio 3', 'http://h/a.mp4').series).toEqual({ show: 'La Casa de Papel', season: 2, episode: 3 });
    expect(c('Dark.S01.E04.1080p.WEB-DL', 'http://h/a.mkv').series).toEqual({ show: 'Dark', season: 1, episode: 4 });
    expect(c('EN| Succession S04 E10', 'http://h/a.mp4').series?.show).toBe('Succession');
  });

  it('recognizes VOD group names in several languages', () => {
    for (const g of ['VOD | Action', 'Películas VOD', 'Filmes VOD', 'FR| Films VOD', 'DE Kino VOD', 'Фильмы VOD', 'أفلام VOD']) {
      expect(c('Some Title', 'http://h/u/p/123', g).kind, g).toBe('movie');
    }
    // Movie groups + a year in the name are movies even without "VOD".
    for (const g of ['Movies', 'Películas', 'Filme', 'Cinéma', 'Фильмы']) {
      expect(c('Some Title (2021)', 'http://h/u/p/124', g).kind, g).toBe('movie');
    }
    for (const g of ['Series', 'Séries', 'Serien', 'Dizi', 'Сериалы', 'TV Shows', 'مسلسلات']) {
      expect(c('Show S01E02', 'http://h/u/p/125', g).kind, g).toBe('series');
    }
  });

  it('keeps live channels in "Movies" groups live', () => {
    expect(c('HBO East', 'http://h/u/p/200', 'US| Movies').kind).toBe('live');
    expect(c('Cinemax HD', 'http://h/stream.m3u8', 'Movies').kind).toBe('live');
    expect(c('Sky Cinema', 'http://h/u/p/201.ts', 'UK| Cinema').kind).toBe('live');
  });

  it('uses media extensions', () => {
    expect(c('Big Buck Bunny', 'https://cdn.example/bbb.mp4').kind).toBe('movie');
    expect(c('Clip', 'https://cdn.example/a.mkv?token=1').kind).toBe('movie');
    expect(c('News', 'https://cdn.example/live.m3u8').kind).toBe('live');
    expect(c('Radio', 'udp://239.0.0.1:1234').kind).toBe('live');
  });

  it('strips quality tags, language prefixes and years', () => {
    expect(c('EN| The Matrix (1999) [4K]', 'http://h/movie/u/p/1.mkv')).toEqual({ kind: 'movie', title: 'The Matrix', year: 1999 });
    expect(c('[US] Dune Part Two 2024 1080p HEVC', 'http://h/movie/u/p/2.mkv')).toEqual({ kind: 'movie', title: 'Dune Part Two', year: 2024 });
    expect(c('Heat.1995.BluRay.x264', 'http://h/a.mp4')).toEqual({ kind: 'movie', title: 'Heat', year: 1995 });
    expect(c('Up', 'http://h/a.mp4')).toEqual({ kind: 'movie', title: 'Up' });
  });

  it('flows through parseM3U', () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="espn" group-title="Sports",ESPN',
      'http://h/live/u/p/1.ts',
      '#EXTINF:-1 tvg-logo="http://img/p.jpg" group-title="VOD Action",Heat (1995)',
      'http://h/movie/u/p/2.mp4',
      '#EXTINF:-1 group-title="Series",Lost S01E01',
      'http://h/series/u/p/3.mkv',
    ].join('\n');
    const { channels } = parseM3U(m3u, 's');
    expect(channels.map((x) => x.kind ?? 'live')).toEqual(['live', 'movie', 'series']);
    expect(channels[0].kind).toBeUndefined();
    expect(channels[1]).toMatchObject({ title: 'Heat', year: 1995, logo: 'http://img/p.jpg' });
    expect(channels[2].series).toEqual({ show: 'Lost', season: 1, episode: 1 });
  });
});
