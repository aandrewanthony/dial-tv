import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Rewind, FastForward, RotateCcw, RotateCw } from 'lucide-react';

/** h:mm:ss / m:ss */
export function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

interface Props {
  /** Current position on the movie's timeline (seconds; includes the decoder's start offset). */
  position(): number;
  /** Buffered ranges on the same timeline. */
  buffered(): [number, number][];
  duration: number;
  paused: boolean;
  onSeek(seconds: number): void;
  onSkip(delta: number): void;
  onToggle(): void;
}

/** Movie / episode controls: seek bar with buffered ranges, elapsed / remaining, ±10 s / ±30 s. */
export default function VodControls({ position, buffered, duration, paused, onSeek, onSkip, onToggle }: Props) {
  const [, tick] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  const dur = duration > 0 ? duration : 0;
  const pos = Math.min(drag ?? position(), dur || Infinity);
  const pct = (x: number) => (dur ? `${Math.max(0, Math.min(100, (x / dur) * 100))}%` : '0%');
  const commit = () => {
    if (dragRef.current != null) onSeek(dragRef.current);
    dragRef.current = null;
    setDrag(null);
  };
  return (
    <div className="vodBar" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="vodTime" aria-label="Elapsed">{formatTime(pos)}</span>
      <div className="vodSeek">
        <div className="vodTrack">
          {dur > 0 && buffered().map(([a, b], i) => <span key={i} className="vodBuf" style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }} />)}
          <span className="vodPlayed" style={{ width: pct(pos) }} />
        </div>
        <input
          type="range" min={0} max={dur || 1} step={1} value={Math.floor(pos)} disabled={!dur} aria-label="Seek"
          onChange={(e) => { dragRef.current = +e.target.value; setDrag(+e.target.value); }}
          onPointerUp={commit} onKeyUp={commit} onBlur={commit}
        />
      </div>
      <span className="vodTime" aria-label="Remaining">{dur ? `-${formatTime(dur - pos)}` : '--:--'}</span>
      <div className="vodBtns">
        <button title="Back 30 s (Shift+←)" onClick={() => onSkip(-30)}><Rewind /></button>
        <button title="Back 10 s (←)" onClick={() => onSkip(-10)}><RotateCcw /></button>
        <button title="Play/Pause (Space)" onClick={onToggle}>{paused ? <Play /> : <Pause />}</button>
        <button title="Forward 10 s (→)" onClick={() => onSkip(10)}><RotateCw /></button>
        <button title="Forward 30 s (Shift+→)" onClick={() => onSkip(30)}><FastForward /></button>
      </div>
    </div>
  );
}
