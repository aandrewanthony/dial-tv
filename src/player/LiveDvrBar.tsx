import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import { formatTime } from './VodControls';

/**
 * The pause & rewind window on the <video> timeline (seconds). `live` is where "LIVE" plays from;
 * `behind` is how far the playhead is behind that (keeps counting while paused).
 */
export interface LiveWindow { start: number; end: number; live: number; behind: number }

interface Props {
  window(): LiveWindow | null;
  position(): number;
  paused: boolean;
  onSeek(seconds: number): void;
  onSkip(delta: number): void;
  onLive(): void;
  onToggle(): void;
}

/** Behind this much, the viewer is "at live" (the buffer itself starts a couple of segments back). */
const AT_LIVE = 4;

/** Live DVR bar (pause & rewind): buffered window, position, −10 s / +30 s, drag to seek, LIVE. */
export default function LiveDvrBar({ window: win, position, paused, onSeek, onSkip, onLive, onToggle }: Props) {
  const [, tick] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  const w = win();
  const span = w ? Math.max(1, w.end - w.start) : 1;
  const pos = drag ?? position();
  const pct = (x: number) => `${w ? Math.max(0, Math.min(100, ((x - w.start) / span) * 100)) : 0}%`;
  const behind = !w ? 0 : drag != null ? Math.max(0, w.live - drag) : w.behind;
  const atLive = behind < AT_LIVE;
  const commit = () => {
    if (dragRef.current != null) onSeek(dragRef.current);
    dragRef.current = null;
    setDrag(null);
  };
  return (
    <div className="vodBar liveDvr" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="vodTime" title="Oldest point you can rewind to">{w ? `\u2212${formatTime(w.live - w.start)}` : '--:--'}</span>
      <div className="vodSeek">
        <div className="vodTrack">
          {w && <span className="vodBuf" style={{ left: 0, width: pct(w.end) }} />}
          <span className="vodPlayed" style={{ width: pct(pos) }} />
        </div>
        <input
          type="range" min={w ? Math.floor(w.start) : 0} max={w ? Math.ceil(w.live) : 1} step={1} value={Math.floor(pos)} disabled={!w}
          aria-label="Rewind position"
          onChange={(e) => { dragRef.current = +e.target.value; setDrag(+e.target.value); }}
          onPointerUp={commit} onKeyUp={commit} onBlur={commit}
        />
      </div>
      <span className={`liveBehind ${atLive ? 'at' : ''}`} aria-live="off">{atLive ? 'Live' : `\u2212${formatTime(behind)} behind live`}</span>
      <div className="vodBtns">
        <button title="Back 10 s (←)" onClick={() => onSkip(-10)}><RotateCcw /></button>
        <button title="Play/Pause (Space)" onClick={onToggle}>{paused ? <Play /> : <Pause />}</button>
        <button title="Forward 30 s (→)" onClick={() => onSkip(30)} disabled={atLive}><RotateCw /></button>
        <button className={`liveBtn ${atLive ? 'on' : ''}`} title="Jump to live" onClick={onLive}>LIVE</button>
      </div>
    </div>
  );
}
