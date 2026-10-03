import { forwardRef, useEffect, useMemo, useState, type ReactNode } from 'react';
import { SkipForward, Tv } from 'lucide-react';
import Player, { type PlayerHandle } from '../../player/Player';
import { useApp } from '../../store/app';
import { learnDuration, personalEnded, useTv } from '../../store/tv';
import { slotAt, type PersonalChannel } from '../../lib/personalSchedule';
import { buildLibrary } from './library';

interface Props {
  def: PersonalChannel;
  compact?: boolean;
  muted?: boolean;
  theater?: boolean;
  onTheater?: () => void;
  overlay?: ReactNode;
}

/**
 * Plays a personal channel like live TV: the scheduled item at its scheduled offset, then the
 * next item when it ends (and the schedule is corrected to match what really happened).
 */
export const PersonalPlayer = forwardRef<PlayerHandle, Props>(function PersonalPlayer({ def, compact, muted, theater, onTheater, overlay }, ref) {
  const durations = useTv((s) => s.durations);
  const channels = useApp((s) => s.channels);
  const lib = useMemo(() => buildLibrary(channels), [channels]);
  // Re-evaluate what's on only when the channel definition changes (edits, item ended, duration
  // learned) — not on every tick, so the playing item is never cut by a timer.
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slot = useMemo(() => slotAt(def, durations, Date.now()), [def, tick]);
  const item = slot ? lib.byId.get(slot.item.id) : undefined;
  // Remount the player per scheduled airing.
  const key = slot ? `${slot.item.id}@${slot.start}` : 'none';
  // Join the airing where the schedule is now (fixed per airing so corrections don't re-seek).
  const startAt = useMemo(() => (slot ? Math.max(0, Math.floor(slot.offset)) : 0), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Item missing from the loaded playlists: skip it after a moment (only once playlists are loaded).
  const missing = !!slot && !item;
  useEffect(() => {
    if (!missing || !channels.length || !slot) return;
    const t = setTimeout(() => personalEnded(def.id, slot.index), 6000);
    return () => clearTimeout(t);
  }, [missing, channels.length, def.id, slot]);

  // Nothing scheduled? Re-check every minute (e.g. items added in another view).
  useEffect(() => {
    if (slot) return;
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, [slot]);

  if (!slot) {
    return <div className="tvPlaceholder"><Tv /><b>{def.name}</b><span>This channel has nothing scheduled yet. Add movies or episodes in My Channels.</span></div>;
  }
  if (!item) {
    return (
      <div className="tvPlaceholder">
        <Tv /><b>{slot.item.title}</b>
        <span>{channels.length ? 'Not in your loaded playlists. Skipping…' : 'Loading your playlists…'}</span>
        <button onClick={() => personalEnded(def.id, slot.index)}><SkipForward /> Next</button>
      </div>
    );
  }
  return (
    <Player
      key={key}
      ref={ref}
      channel={item}
      vod
      startAt={startAt}
      compact={compact}
      muted={muted}
      theater={theater}
      onTheater={onTheater}
      overlay={overlay}
      onProgress={(_s: number, d: number) => { if (d && Number.isFinite(d)) learnDuration(item.id, d); }}
      onEnded={() => personalEnded(def.id, slot.index)}
    />
  );
});
