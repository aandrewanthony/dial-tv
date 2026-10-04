import { describe, expect, it } from 'vitest';
import { downsample, usableColor, wpLatest, wpPaths } from '../../src/lib/winProb';

describe('win probability chart', () => {
  it('downsamples long series keeping both ends', () => {
    const s = Array.from({ length: 1000 }, (_, i) => i / 999);
    const d = downsample(s, 100);
    expect(d).toHaveLength(100);
    expect(d[0]).toBe(0);
    expect(d[99]).toBe(1);
    expect(downsample([0.1, 0.2])).toEqual([0.1, 0.2]);
  });
  it('draws home above the midline and closes the area on it', () => {
    const { line, area } = wpPaths([0.5, 1, 0], 100, 40);
    expect(line).toBe('M0,20 L50,0 L100,40');
    expect(area).toBe('M0,20 L0,20 L50,0 L100,40 L100,20 Z');
  });
  it('handles single points, bad values and empty series', () => {
    expect(wpPaths([0.75], 100, 40).line).toBe('M0,10 L100,10');
    expect(wpPaths([Number.NaN, 2, -1], 100, 40).line).toBe('M0,20 L50,0 L100,40');
    expect(wpPaths([], 100, 40)).toEqual({ line: '', area: '' });
  });
  it('reports the current leader and percent', () => {
    expect(wpLatest([0.5, 0.783])).toEqual({ home: 78, leader: 'home', pct: 78 });
    expect(wpLatest([0.5, 0.12])).toEqual({ home: 12, leader: 'away', pct: 88 });
    expect(wpLatest([0.5])).toMatchObject({ leader: 'home', pct: 50 });
    expect(wpLatest([])).toBeNull();
  });
  it('falls back from team colors that vanish on dark or light backgrounds', () => {
    expect(usableColor('#0076b6')).toBe('#0076b6');
    expect(usableColor('#311d00')).toBeNull(); // near-black brown
    expect(usableColor('#ff3c00')).toBe('#ff3c00');
    expect(usableColor('#000000')).toBeNull();
    expect(usableColor('#ffffff')).toBeNull();
    expect(usableColor(undefined)).toBeNull();
    expect(usableColor('red')).toBeNull();
  });
});
