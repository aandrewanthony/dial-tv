import { memo, useState } from 'react';
import { Check, Clapperboard, Heart, Tv } from 'lucide-react';
import { hueOf } from './library';

/** Poster art from the playlist logo, with a generated title card when missing or broken. */
export const Poster = memo(function Poster({ src, title, sub, kind = 'movie', progress, watched, fav }: {
  src?: string;
  title: string;
  sub?: string;
  kind?: 'movie' | 'series';
  /** 0..1 */
  progress?: number;
  watched?: boolean;
  fav?: boolean;
}) {
  const [bad, setBad] = useState(false);
  const h = hueOf(title);
  return (
    <div className="tvPoster" style={{ ['--h' as string]: h }}>
      {src && !bad ? (
        <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBad(true)} />
      ) : (
        <div className="tvPosterFallback">
          {kind === 'series' ? <Tv /> : <Clapperboard />}
          <b>{title}</b>
          {sub && <small>{sub}</small>}
        </div>
      )}
      {watched && <span className="tvPosterBadge" title="Watched"><Check /></span>}
      {fav && <span className="tvPosterFav" title="Favorite"><Heart fill="currentColor" /></span>}
      {progress != null && progress > 0 && !watched && <div className="tvPosterBar"><i style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>}
    </div>
  );
});

export const fmtDur = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
