/**
 * Win probability chart geometry (pure; drawn by components/WinProbability.tsx).
 * Series values are ESPN's homeWinPercentage (0..1) in play order. Home is drawn above the
 * 50% midline, away below.
 */

/** Keep at most `max` points, always including the first and last. */
export function downsample(series: number[], max = 160): number[] {
  if (series.length <= max) return series;
  const out: number[] = [];
  const step = (series.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(series[Math.round(i * step)]);
  return out;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
const r = (n: number) => Math.round(n * 100) / 100;

/** SVG path data for the probability line and the area between it and the midline. */
export function wpPaths(series: number[], w: number, h: number): { line: string; area: string } {
  const pts = downsample(series).map(clamp01);
  if (!pts.length) return { line: '', area: '' };
  if (pts.length === 1) pts.push(pts[0]);
  const x = (i: number) => r((i / (pts.length - 1)) * w);
  const y = (p: number) => r((1 - p) * h);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p)}`).join(' ');
  const mid = r(h / 2);
  return { line, area: `M0,${mid} ${line.replace(/^M/, 'L')} L${w},${mid} Z` };
}

/** Latest home win chance in whole percent, and which side leads (ties go home). */
export function wpLatest(series: number[]): { home: number; leader: 'home' | 'away'; pct: number } | null {
  if (!series.length) return null;
  const home = Math.round(clamp01(series[series.length - 1]) * 100);
  return home >= 50 ? { home, leader: 'home', pct: home } : { home, leader: 'away', pct: 100 - home };
}

/** Team color if it reads on both dark and light backgrounds, else null (caller picks a theme color). */
export function usableColor(hex: string | undefined): string | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum < 0.03 || lum > 0.8 ? null : hex!;
}
