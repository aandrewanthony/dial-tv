import { create } from 'zustand';
import { ExternalLink } from 'lucide-react';
import type { BetLeg } from '../../lib/sports';
import { bookInfo } from '../../providers/oddsapi';
import { fmtMoney } from '../../lib/sports';

/** Open a sportsbook link in the real browser (the desktop shell hands http(s) window.open to the OS). */
export function openExternal(url: string) {
  if (!/^https:\/\//i.test(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function BookButton({ book, title, link, label }: { book: string; title?: string; link?: string; label?: string }) {
  const info = bookInfo(book, title);
  const url = link ?? info.home;
  if (!url) return null;
  return (
    <button className="bookBtn" style={{ ['--book' as string]: info.color }} onClick={() => openExternal(url)} title={link ? `Open this bet at ${info.title}` : `Open ${info.title}`}>
      {label ?? `Bet at ${info.title}`} <ExternalLink />
    </button>
  );
}

/** Legs picked on the odds board for the parlay calculator / "track this bet". */
interface Slip {
  legs: (BetLeg & { book?: string; link?: string })[];
  add: (l: BetLeg & { book?: string; link?: string }) => void;
  remove: (id: string) => void;
  clear: () => void;
}
export const useSlip = create<Slip>((set) => ({
  legs: [],
  add: (l) => set((s) => ({ legs: [...s.legs.filter((x) => !(x.eventId && x.eventId === l.eventId && x.market === l.market)), l] })),
  remove: (id) => set((s) => ({ legs: s.legs.filter((x) => x.id !== id) })),
  clear: () => set({ legs: [] }),
}));

export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Tiny line chart (line movement). */
export function Sparkline({ values, width = 64, height = 18, invert }: { values: number[]; width?: number; height?: number; invert?: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 2) + 1;
    const n = (v - min) / span;
    const y = (invert ? n : 1 - n) * (height - 2) + 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** Weekly P/L bars with a cumulative line. */
export function WeeklyChart({ data }: { data: { week: number; profit: number }[] }) {
  const W = 560;
  const H = 150;
  const pad = 24;
  let run = 0;
  const cum = data.map((d) => (run += d.profit));
  const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.profit)), ...cum.map(Math.abs));
  const y = (v: number) => H / 2 - (v / maxAbs) * (H / 2 - 12);
  const bw = (W - pad) / data.length;
  return (
    <svg className="weeklyChart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly profit and loss">
      <line x1={pad} x2={W} y1={H / 2} y2={H / 2} className="axis" />
      {data.map((d, i) => {
        const h = Math.abs(y(d.profit) - H / 2);
        return (
          <g key={d.week}>
            <rect x={pad + i * bw + 3} y={d.profit >= 0 ? y(d.profit) : H / 2} width={Math.max(2, bw - 6)} height={Math.max(d.profit ? 1 : 0, h)} className={d.profit >= 0 ? 'up' : 'down'}>
              <title>{`Week of ${new Date(d.week).toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${fmtMoney(d.profit, true)}`}</title>
            </rect>
            {i % 2 === 0 && <text x={pad + i * bw + bw / 2} y={H - 2} textAnchor="middle">{new Date(d.week).toLocaleDateString([], { month: 'numeric', day: 'numeric' })}</text>}
          </g>
        );
      })}
      <polyline className="cum" fill="none" points={cum.map((v, i) => `${pad + i * bw + bw / 2},${y(v)}`).join(' ')} />
      <text x={2} y={12} className="lbl">{fmtMoney(maxAbs)}</text>
    </svg>
  );
}
