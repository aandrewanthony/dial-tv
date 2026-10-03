import { useMemo, useState } from 'react';
import { BookmarkPlus, BookmarkCheck, Check, Eye, EyeOff, Heart, Play, RotateCcw } from 'lucide-react';
import type { Channel } from '../../types';
import { Modal } from '../ui';
import { markWatched, toggleIn, useTv, type VodProgress } from '../../store/tv';
import { episodeName, epLabel, titleOf, type Show } from './library';
import { Poster, fmtDur } from './Poster';
import { playVod } from './VodPlayer';

const pct = (p?: VodProgress) => (p && p.dur ? p.pos / p.dur : 0);

export function MovieDetails({ item, onClose }: { item: Channel; onClose: () => void }) {
  const p = useTv((s) => s.progress[item.id]);
  const fav = useTv((s) => s.favorites.includes(item.id));
  const wl = useTv((s) => s.watchlist.includes(item.id));
  const canResume = p && !p.watched && p.pos >= 30;
  return (
    <Modal title={titleOf(item)} onClose={onClose} wide>
      <div className="tvDetails">
        <Poster src={item.logo} title={titleOf(item)} sub={item.year ? String(item.year) : undefined} />
        <div className="tvDetailsBody">
          <p className="tvDetailsMeta">{[item.year, item.group, p?.dur ? fmtDur(p.dur) : undefined].filter(Boolean).join(' · ')}</p>
          {canResume && <div className="tvResume"><div className="bar"><i style={{ width: `${pct(p) * 100}%` }} /></div><small>{fmtDur(p.pos)} watched{p.dur ? ` of ${fmtDur(p.dur)}` : ''}</small></div>}
          {p?.watched && <p className="tvWatched"><Check /> Watched</p>}
          <div className="row">
            <button className="primary" autoFocus onClick={() => playVod(item.id)}><Play /> {canResume ? `Resume ${fmtDur(p.pos)}` : 'Play'}</button>
            {canResume && <button onClick={() => playVod(item.id, { startOver: true })}><RotateCcw /> Start over</button>}
          </div>
          <div className="row">
            <button onClick={() => toggleIn('favorites', item.id)}><Heart fill={fav ? 'currentColor' : 'none'} /> {fav ? 'Favorite' : 'Add to favorites'}</button>
            <button onClick={() => toggleIn('watchlist', item.id)}>{wl ? <BookmarkCheck /> : <BookmarkPlus />} {wl ? 'On watchlist' : 'Watchlist'}</button>
            <button onClick={() => markWatched(item.id, !p?.watched)}>{p?.watched ? <EyeOff /> : <Eye />} {p?.watched ? 'Mark unwatched' : 'Mark watched'}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** The episode to offer first: in progress, else the one after the last watched, else the first. */
export function upNextEpisode(show: Show, progress: Record<string, VodProgress>): Channel | undefined {
  let lastWatched = -1;
  let latest: { i: number; at: number } | null = null;
  show.episodes.forEach((e, i) => {
    const p = progress[e.id];
    if (!p) return;
    if (p.watched) lastWatched = Math.max(lastWatched, i);
    else if (p.pos >= 30 && (!latest || p.at > latest.at)) latest = { i, at: p.at };
  });
  if (latest) return show.episodes[(latest as { i: number }).i];
  return show.episodes[lastWatched + 1] ?? show.episodes[0];
}

export function ShowDetails({ show, onClose }: { show: Show; onClose: () => void }) {
  const progress = useTv((s) => s.progress);
  const fav = useTv((s) => s.favorites.includes(show.key));
  const wl = useTv((s) => s.watchlist.includes(show.key));
  const nextUp = useMemo(() => upNextEpisode(show, progress), [show, progress]);
  const [season, setSeason] = useState(() => nextUp?.series?.season ?? show.seasons[0]?.season ?? 1);
  const eps = show.seasons.find((s) => s.season === season)?.episodes ?? [];
  const np = nextUp ? progress[nextUp.id] : undefined;
  const resuming = np && !np.watched && np.pos >= 30;
  return (
    <Modal title={show.name} onClose={onClose} wide>
      <div className="tvDetails">
        <Poster src={show.logo} title={show.name} kind="series" sub={`${show.seasons.length} season${show.seasons.length === 1 ? '' : 's'}`} />
        <div className="tvDetailsBody">
          <p className="tvDetailsMeta">{show.group} · {show.seasons.length} season{show.seasons.length === 1 ? '' : 's'} · {show.episodes.length} episodes</p>
          <div className="row">
            {nextUp && (
              <button className="primary" autoFocus onClick={() => playVod(nextUp.id)}>
                <Play /> {resuming ? `Resume ${epLabel(nextUp)}` : `Play ${epLabel(nextUp)}`}
              </button>
            )}
            <button onClick={() => toggleIn('favorites', show.key)}><Heart fill={fav ? 'currentColor' : 'none'} /> {fav ? 'Favorite' : 'Add to favorites'}</button>
            <button onClick={() => toggleIn('watchlist', show.key)}>{wl ? <BookmarkCheck /> : <BookmarkPlus />} {wl ? 'On watchlist' : 'Watchlist'}</button>
          </div>
          <div className="chips tvSeasons" role="tablist" aria-label="Seasons">
            {show.seasons.map((s) => (
              <button key={s.season} role="tab" aria-selected={s.season === season} className={s.season === season ? 'on' : ''} onClick={() => setSeason(s.season)}>Season {s.season}</button>
            ))}
          </div>
          <div className="tvEpisodes">
            {eps.map((e) => {
              const p = progress[e.id];
              return (
                <div key={e.id} className={`tvEpisode ${nextUp?.id === e.id ? 'next' : ''}`}>
                  <button className="tvEpisodePlay" onClick={() => playVod(e.id)} aria-label={`Play ${epLabel(e)}`}><Play /></button>
                  <div className="tvEpisodeText">
                    <b>{epLabel(e)} · {episodeName(e)}</b>
                    {p && !p.watched && p.dur > 0 && <div className="bar"><i style={{ width: `${pct(p) * 100}%` }} /></div>}
                  </div>
                  <button className="icon" title={p?.watched ? 'Mark unwatched' : 'Mark watched'} onClick={() => markWatched(e.id, !p?.watched)}>
                    {p?.watched ? <Check className="tvOk" /> : <Eye />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
