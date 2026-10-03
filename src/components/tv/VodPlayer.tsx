import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, SkipForward, X } from 'lucide-react';
import Player, { type PlayerHandle } from '../../player/Player';
import { useApp } from '../../store/app';
import { markWatched, resumeAt, saveProgress, useTv } from '../../store/tv';
import { navigate, replaceRoute } from '../../app/router';
import { LockedScreen, useLockedOut } from '../ui';
import { buildLibrary, episodeName, epLabel, nextEpisode, titleOf } from './library';

const COUNTDOWN = 10;

/** One-shot "start from the beginning" request for the next VOD player view. */
let startOverId: string | null = null;
export function playVod(id: string, opts: { startOver?: boolean } = {}) {
  startOverId = opts.startOver ? id : null;
  navigate('movies', id);
}

/** Full player view for a movie / episode (#/movies/<id>), with resume and next-episode autoplay. */
export function VodPlayerView({ id }: { id: string }) {
  const channels = useApp((s) => s.channels);
  const loading = useApp((s) => s.loadingSources);
  const resume = useApp((s) => s.settings.playback.resumeVod);
  const tvReady = useTv((s) => s.hydrated);
  const lib = useMemo(() => buildLibrary(channels), [channels]);
  const item = lib.byId.get(id);
  const next = item?.kind === 'series' ? nextEpisode(lib, id) : undefined;
  const lockedOut = useLockedOut(id);
  const player = useRef<PlayerHandle>(null);
  const [count, setCount] = useState<number | null>(null);

  // Decided once per item (after the TV store has loaded), so progress saves don't re-seek.
  const startAt = useMemo(() => {
    if (!tvReady) return undefined;
    if (startOverId === id) { startOverId = null; return 0; }
    return resume ? resumeAt(id) ?? 0 : 0;
  }, [id, tvReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setCount(null), [id]);
  useEffect(() => {
    if (count == null) return;
    if (count <= 0) {
      if (next) replaceRoute('movies', next.id);
      return;
    }
    const t = setTimeout(() => setCount((c) => (c == null ? c : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [count, next]);

  // Player keys + Esc back to the library.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.('input, select, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('.scrim, [role=dialog]')) return;
      const p = player.current;
      switch (e.key) {
        case ' ': case 'k': if (t?.closest?.('button, a, [role=switch]')) return; e.preventDefault(); p?.togglePlay(); break;
        case 'm': p?.toggleMute(); break;
        case 'f': p?.fullscreen(); break;
        case 'i': p?.toggleStats(); break;
        case '[': p?.volume(-0.1); break;
        case ']': p?.volume(0.1); break;
        case 'Escape': if (!document.fullscreenElement) navigate('movies'); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!item) {
    return (
      <div className="empty">
        <b>{loading || !channels.length ? 'Loading your library…' : 'This title is not in your playlists anymore.'}</b>
        <button className="ghost" onClick={() => navigate('movies')}><ArrowLeft /> Back to Movies & Series</button>
      </div>
    );
  }

  const title = item.kind === 'series' ? `${item.series?.show ?? titleOf(item)} · ${epLabel(item)}` : titleOf(item);
  return (
    <div className="tvVodView">
      <div className="tvVodBar">
        <button className="ghost" onClick={() => navigate('movies')}><ArrowLeft /> Library</button>
        <div className="tvVodTitle"><b>{title}</b><small>{item.year ? `${item.year} · ` : ''}{item.group}</small></div>
        {next && <button onClick={() => replaceRoute('movies', next.id)}><SkipForward /> Next: {epLabel(next)}</button>}
      </div>
      <div className="screen tvVodScreen">
        {lockedOut ? <LockedScreen /> : startAt == null ? null : (
          <Player
            key={id}
            ref={player}
            channel={item}
            vod
            startAt={startAt}
            onProgress={(s: number, d: number) => saveProgress(id, s, d)}
            onEnded={() => {
              markWatched(id, true);
              if (next) setCount(COUNTDOWN);
            }}
            overlay={count != null && next ? (
              <div className="tvNextUp" role="status">
                <small>NEXT EPISODE</small>
                <b>{epLabel(next)} · {episodeName(next)}</b>
                <span>Starting in {count} s</span>
                <div className="row">
                  <button className="primary" onClick={() => replaceRoute('movies', next.id)}><SkipForward /> Play now</button>
                  <button onClick={() => setCount(null)}><X /> Cancel</button>
                </div>
              </div>
            ) : undefined}
          />
        )}
      </div>
    </div>
  );
}
