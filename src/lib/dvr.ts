/**
 * DVR (desktop): the renderer side of electron/dvr.cjs. The shell owns schedules, files and stream
 * links; this keeps a mirror of its list for the UI and builds recording requests from channels.
 */
import { create } from 'zustand';
import { channelHeaders, desktop } from './net';
import type { Channel, Program } from '../types';

export type RecStatus = 'scheduled' | 'recording' | 'processing' | 'done' | 'failed' | 'cancelled' | 'missed';

export interface Recording {
  id: string;
  channelId: string;
  channelName: string;
  title: string;
  subtitle?: string;
  programId?: string;
  start: number;
  end: number;
  status: RecStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  file?: string;
  bytes?: number;
  error?: string;
  partial?: boolean;
  /** An ffmpeg process is running for it right now. */
  live?: boolean;
  /** Made by a recording rule (src/lib/dvrRules.ts). */
  rule?: RecRule;
  /** End before a running game pushed it later. */
  origEnd?: number;
}

/** Which rule made a recording: `label` shows as "Auto: …", `key` identifies the game / airing. */
export interface RecRule {
  id: string;
  label: string;
  key: string;
}

export interface DvrSettings {
  folder: string;
  /** Recordings that may run at once (each one is a connection to your provider). */
  maxConcurrent: number;
  /** Minutes added before / after a show from the guide. */
  padBefore: number;
  padAfter: number;
}

export interface DvrSnapshot {
  available: boolean;
  settings: DvrSettings;
  recordings: Recording[];
}

export interface DvrJob {
  channelId: string;
  channelName: string;
  title: string;
  subtitle?: string;
  programId?: string;
  start: number;
  end: number;
  url: string;
  headers: Record<string, string>;
  rule?: RecRule;
}

export interface DvrBridge {
  list(): Promise<DvrSnapshot>;
  schedule(job: DvrJob): Promise<{ id?: string; error?: string; conflicts?: boolean }>;
  stop(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  /** Push a recording's end later (max +90 min over its original end). */
  extend(id: string, end: number): Promise<boolean>;
  playUrl(id: string): Promise<string | null>;
  reveal(id?: string | null): Promise<boolean>;
  settings(patch?: Partial<DvrSettings> | null): Promise<DvrSettings>;
  chooseFolder(): Promise<string | null>;
  onChange(fn: (s: DvrSnapshot) => void): () => void;
}

export const dvrBridge = (): DvrBridge | undefined => desktop()?.dvr;

export const useDvr = create<DvrSnapshot & { ready: boolean }>(() => ({
  ready: false,
  available: false,
  settings: { folder: '', maxConcurrent: 2, padBefore: 1, padAfter: 3 },
  recordings: [],
}));

let started = false;
/** Start mirroring the shell's DVR list (once; no-op on the web). */
export function initDvr() {
  const b = dvrBridge();
  if (started || !b) return;
  started = true;
  b.onChange((s) => useDvr.setState({ ...s, ready: true }));
  void b.list().then((s) => useDvr.setState({ ...s, ready: true })).catch(() => {});
}

export const isActive = (r: Recording) => r.status === 'scheduled' || r.status === 'recording';

/** The active recording of this channel at `at` (or now), if any. */
export function recordingOn(recs: Recording[], channelId: string, at = Date.now()) {
  return recs.find((r) => isActive(r) && r.channelId === channelId && r.start <= at + 60_000 && r.end > at);
}

/** The recording scheduled for this guide programme, if any. */
export function recordingFor(recs: Recording[], channelId: string, p: Pick<Program, 'id' | 'start' | 'end'>) {
  return recs.find((r) => isActive(r) && r.channelId === channelId && (r.programId === p.id || (r.start <= p.start && r.end >= p.end)));
}

export function jobBase(c: Channel) {
  return { channelId: c.id, channelName: (c as { displayName?: string }).displayName ?? c.name, url: c.url, headers: channelHeaders(c) };
}

/** Record a guide programme, with the padding from settings. */
export function jobForProgram(c: Channel, p: Program, s: DvrSettings): DvrJob {
  return { ...jobBase(c), title: p.title, subtitle: p.subtitle, programId: p.id, start: p.start - s.padBefore * 60_000, end: p.end + s.padAfter * 60_000 };
}

/** Record now: until the current programme ends (plus padding), or for `minutes` when there's no guide. */
export function jobForNow(c: Channel, now: Program | undefined, s: DvrSettings, minutes = 60): DvrJob {
  const t = Date.now();
  const end = now && now.end > t + 60_000 ? now.end + s.padAfter * 60_000 : t + minutes * 60_000;
  return { ...jobBase(c), title: now?.title ?? jobBase(c).channelName, subtitle: now?.subtitle, programId: now?.id, start: t, end };
}

export function fmtBytes(n?: number) {
  if (!n) return '';
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}
