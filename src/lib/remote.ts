/**
 * Remote Control (desktop): a phone on the same Wi-Fi sends commands through the desktop
 * shell's LAN server (electron/remote.cjs). The main process validates them; here they are
 * routed to Live TV, which maps them onto its existing actions (tune, player handle, guide).
 */
import { useEffect } from 'react';
import { desktop } from './net';
import { ROUTES } from '../app/router';
import type { Channel } from '../types';
import type { PlayerHandle } from '../player/Player';

export type RemoteCommand =
  | { type: 'chup' | 'chdown' | 'play' | 'mute' | 'volup' | 'voldown' | 'last' | 'guide' }
  | { type: 'number'; value: string }
  | { type: 'tune'; id: string };

/** Now-playing pushed to paired phones. */
export interface RemoteState {
  channel: { number: string; name: string } | null;
  currentId?: string;
  title?: string;
  time?: string;
  next?: string;
  guideOpen?: boolean;
  favorites: { id: string; number: string; name: string }[];
}

export interface RemoteDevice { id: string; name: string; created: number; lastSeen: number; connected?: boolean }
export interface RemoteStatus {
  enabled: boolean;
  on: boolean;
  port: number;
  url: string | null;
  urls: string[];
  code: string | null;
  devices: RemoteDevice[];
  error: string | null;
}

export interface RemoteBridge {
  status(): Promise<RemoteStatus>;
  setEnabled(on: boolean): Promise<RemoteStatus>;
  revoke(id: string): Promise<RemoteStatus>;
  newCode(): Promise<RemoteStatus>;
  publish(state: RemoteState): void;
  onCommand(cb: (cmd: RemoteCommand, from?: string) => void): () => void;
  onStatus(cb: (s: RemoteStatus) => void): () => void;
}

export const remoteBridge = (): RemoteBridge | undefined => (desktop() as unknown as { remote?: RemoteBridge } | undefined)?.remote;

// ---- Routing: Live TV registers a handler; commands that arrive elsewhere wait for it. ----
type Handler = (cmd: RemoteCommand) => void;
let handler: Handler | null = null;
const pending: RemoteCommand[] = [];

export function setRemoteHandler(h: Handler): () => void {
  handler = h;
  for (const cmd of pending.splice(0)) h(cmd);
  return () => { if (handler === h) handler = null; };
}

/**
 * Run now if Live TV is open; otherwise queue (a few) and open it. `watchOpen` comes from the
 * route: while another page lazy-loads, React can keep a hidden Live TV mounted for a moment.
 */
export function deliverRemote(cmd: RemoteCommand, openWatch: () => void, watchOpen = true) {
  if (handler && watchOpen) return handler(cmd);
  pending.push(cmd);
  if (pending.length > 8) pending.shift();
  openWatch();
}

/** Run queued commands on the current handler (Live TV shown again without remounting). */
export function flushRemote() {
  if (handler) for (const cmd of pending.splice(0)) handler(cmd);
}

/** Live TV is the default route (empty or unknown hash). */
const routeIsWatch = () => {
  const r = location.hash.replace(/^#\/?/, '').split('/')[0];
  return r === 'watch' || !(ROUTES as string[]).includes(r);
};

/** App-wide: listen to the desktop bridge (no-op on the web). */
export function useRemoteCommands(openWatch: () => void, onWatch: boolean) {
  // Runs after Live TV's own effects, so a fresh mount has already taken the queue.
  useEffect(() => { if (onWatch) flushRemote(); }, [onWatch]);
  useEffect(() => {
    const b = remoteBridge();
    if (!b) return;
    return b.onCommand((cmd) => deliverRemote(cmd, openWatch, routeIsWatch()));
  }, [openWatch]);
}

export interface RemoteTarget {
  /** Channels in zapping order (what ↑/↓ and numbers use on Live TV). */
  list: Channel[];
  currentId?: string;
  prevId?: string;
  tune(id: string): void;
  player: Pick<PlayerHandle, 'togglePlay' | 'toggleMute' | 'volume'> | null;
  toggleGuide(): void;
  notFound(number: string): void;
}

export const VOLUME_STEP = 0.1;

/** Map a remote command onto Live TV's actions. Returns false when it did nothing. */
export function applyRemoteCommand(cmd: RemoteCommand, t: RemoteTarget): boolean {
  const { list } = t;
  const zap = (d: number) => {
    if (!list.length) return false;
    const idx = list.findIndex((c) => c.id === t.currentId);
    const at = idx < 0 ? (d > 0 ? 0 : list.length - 1) : (idx + d + list.length) % list.length;
    t.tune(list[at].id);
    return true;
  };
  switch (cmd.type) {
    case 'chup': return zap(-1); // same direction as ↑ on the keyboard
    case 'chdown': return zap(1);
    case 'play': t.player?.togglePlay(); return !!t.player;
    case 'mute': t.player?.toggleMute(); return !!t.player;
    case 'volup': t.player?.volume(VOLUME_STEP); return !!t.player;
    case 'voldown': t.player?.volume(-VOLUME_STEP); return !!t.player;
    case 'guide': t.toggleGuide(); return true;
    case 'last':
      if (!t.prevId || t.prevId === t.currentId) return false;
      t.tune(t.prevId);
      return true;
    case 'number': {
      const ch = list.find((c) => String(c.number) === cmd.value);
      if (!ch) { t.notFound(cmd.value); return false; }
      t.tune(ch.id);
      return true;
    }
    case 'tune':
      if (!list.some((c) => c.id === cmd.id)) return false;
      t.tune(cmd.id);
      return true;
  }
  return false;
}
