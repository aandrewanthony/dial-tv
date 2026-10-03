/**
 * Start / rebuffer gate for the <video> element (all engines).
 *
 * Browsers resume playback the moment a few frames arrive after a stall, so a jittery IPTV
 * connection turns into play-0.3 s / freeze / play-0.3 s stutter. The gate holds playback (paused,
 * shown as "Buffering…") until a real cushion has arrived, and grows that cushion after each stall
 * so a flaky source stops pausing. See tuning.ts for the per-profile numbers.
 */
import type { GateOptions } from './tuning';

/** Seconds of media buffered ahead of the playhead (0 when the playhead isn't in a buffered range). */
export function bufferedAhead(v: Pick<HTMLMediaElement, 'buffered' | 'currentTime'>): number {
  const t = v.currentTime;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= t + 0.3 && v.buffered.end(i) > t) return v.buffered.end(i) - t;
  }
  return 0;
}

/**
 * Cushion for the gate: the buffered seconds the playhead will play. Before the first frame the
 * playhead can sit before the first range (the engine jumps to it on play), so count that range.
 */
export function cushion(v: Pick<HTMLMediaElement, 'buffered' | 'currentTime'>): number {
  if (v.buffered.length && v.currentTime < v.buffered.start(0) - 0.3) return v.buffered.end(0) - v.buffered.start(0);
  return bufferedAhead(v);
}

/** End of the last buffered range (how much has arrived). */
export const bufferedEnd = (v: Pick<HTMLMediaElement, 'buffered'>) => (v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0);

export interface Gate {
  /** Start playback (after the start cushion, if any). */
  start(): void;
  /** True while playback is held for the cushion. */
  readonly holding: boolean;
  /** Let the engine handle stalls itself (hls.js keeps its own segment cushion). */
  noRebuffer(): void;
  /** Stop holding and play now (the viewer pressed play). */
  release(): void;
  /** Stop holding without playing (pause pressed, seek, teardown). */
  cancel(): void;
  destroy(): void;
}

export interface GateHooks {
  play(): void;
  onChange?(holding: boolean): void;
  /** Movies: the stream end is reachable, so there is nothing more to wait for. */
  nearEnd?(): boolean;
}

export function createGate(v: HTMLVideoElement, o: GateOptions, hooks: GateHooks): Gate {
  let holding = false;
  let started = false;
  let target = o.rebuffer;
  let since = 0;
  let poll: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;
  let rebuffer = o.rebuffer > 0;

  const stop = () => {
    clearInterval(poll);
    poll = undefined;
    if (holding) { holding = false; hooks.onChange?.(false); }
  };
  const release = () => {
    if (!holding) return;
    stop();
    hooks.play();
  };
  const hold = (want: number, then: () => void) => {
    if (destroyed || holding) return;
    holding = true; // before pause(): the 'pause' event must see that this isn't the viewer
    since = performance.now();
    hooks.onChange?.(true);
    if (!v.paused) v.pause();
    poll = setInterval(() => {
      if (destroyed) return stop();
      const waited = (performance.now() - since) / 1000;
      if (cushion(v) >= want || waited >= o.maxWait || hooks.nearEnd?.()) { stop(); then(); }
    }, 200);
  };
  const onWaiting = () => {
    // A real stall during playback (not the start, not a seek, not while already holding).
    if (!started || holding || v.seeking || v.paused || v.ended || destroyed) return;
    if (!rebuffer) return;
    const want = target;
    target = Math.min(o.rebufferMax, target * 1.5); // a source that stalls again gets a bigger cushion
    hold(want, () => hooks.play());
  };
  v.addEventListener('waiting', onWaiting);

  return {
    start() {
      if (destroyed) return;
      const go = () => { started = true; hooks.play(); };
      if (o.startGate > 0) hold(o.startGate, go);
      else go();
    },
    get holding() { return holding; },
    noRebuffer() { rebuffer = false; },
    release() {
      started = true;
      if (holding) release(); else hooks.play();
    },
    cancel() { started = true; stop(); },
    destroy() {
      destroyed = true;
      stop();
      v.removeEventListener('waiting', onWaiting);
    },
  };
}
