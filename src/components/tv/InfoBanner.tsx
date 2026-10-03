import type { Channel, Program } from '../../types';
import { fmtTime } from '../ui';
import { TvMark } from './personal';

const MIN = 60_000;
export const leftLabel = (p: { end: number }, now: number) => {
  const m = Math.max(0, Math.ceil((p.end - now) / MIN));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
};

/** Cable-style channel banner: number, logo, now (with progress and time left) and next. */
export function InfoBanner({ channel, now, next, at }: { channel: Channel; now?: Program; next?: Program; at: number }) {
  const pct = now ? Math.min(100, Math.max(0, ((at - now.start) / (now.end - now.start)) * 100)) : 0;
  return (
    <div className="tvBanner" role="status" aria-label="Channel info">
      <div className="tvBannerCh">
        <b className="tvBannerNum">{channel.number}</b>
        <TvMark channel={channel} size={46} />
        <div className="tvBannerName"><b>{channel.name}</b><small>{channel.group}</small></div>
        <span className="tvBannerClock">{fmtTime(at)}</span>
      </div>
      <div className="tvBannerRows">
        <div className="tvBannerRow">
          <small>NOW</small>
          {now ? (
            <>
              <b>{now.title}{now.subtitle ? <em> · {now.subtitle}</em> : null}</b>
              <span className="tvBannerTimes">{fmtTime(now.start)} – {fmtTime(now.end)}</span>
              <div className="bar"><i style={{ width: `${pct}%` }} /></div>
              <span className="tvBannerLeft">{leftLabel(now, at)}</span>
            </>
          ) : <b className="muted">No information</b>}
        </div>
        {next && (
          <div className="tvBannerRow next">
            <small>NEXT</small>
            <b>{next.title}</b>
            <span className="tvBannerTimes">{fmtTime(next.start)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
