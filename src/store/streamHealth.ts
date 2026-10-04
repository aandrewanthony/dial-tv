import { createPersisted } from './persisted';
import { isDeadHealth, type HealthMap } from '../lib/streamHealth';

/** Per-provider state of the dead-channel checker (keyed by origin, which carries no login). */
export interface OriginState {
  /** Web: the host answered a browser request (CORS ok) or blocked it, and when. */
  cors?: 'ok' | 'blocked';
  corsAt?: number;
  /** No checks against this host until then (rate limited, or many failures in a row). */
  pauseUntil?: number;
  /** After a run of failures: check a link that worked before, to tell an outage from dead channels. */
  needCanary?: boolean;
  /** The canary worked: failures in a row on this host count normally until then. */
  trustUntil?: number;
}

export interface StreamHealthState {
  /** urlKey(stream URL) → health. */
  urls: HealthMap;
  origins: Record<string, OriginState>;
  /** Local day (YYYY-MM-DD) and checks made on it (daily cap). */
  day: string;
  dayCount: number;
  /** Channels the user asked to re-check: logical id + when asked. */
  recheck: { id: string; at: number }[];
  /** Bumped when some URL's dead/alive state changes (lineups re-filter on it). */
  version: number;
}

export const useStreamHealth = createPersisted<StreamHealthState>({
  key: 'streamHealth',
  version: 1,
  defaults: () => ({ urls: {}, origins: {}, day: '', dayCount: 0, recheck: [], version: 0 }),
});

/** Replace one URL's health; bumps `version` when it became dead or came back. */
export function setUrlHealth(key: string, next: HealthMap[string] | undefined, opts: { bump?: boolean } = {}) {
  useStreamHealth.setState((s) => {
    const before = isDeadHealth(s.urls[key]);
    const urls = { ...s.urls };
    if (next) urls[key] = next;
    else delete urls[key];
    const changed = before !== isDeadHealth(next);
    return { urls, version: changed && opts.bump !== false ? s.version + 1 : s.version };
  });
  return isDeadHealth(useStreamHealth.getState().urls[key]);
}

export const bumpHealthVersion = () => useStreamHealth.setState((s) => ({ version: s.version + 1 }));

export function setOrigin(origin: string, patch: Partial<OriginState>) {
  useStreamHealth.setState((s) => ({ origins: { ...s.origins, [origin]: { ...s.origins[origin], ...patch } } }));
}

/** Queue channels for a check as soon as nothing is playing (manual "Re-check now"). */
export function requestRecheck(ids: string[]) {
  const at = Date.now();
  useStreamHealth.setState((s) => ({ recheck: [...s.recheck.filter((r) => !ids.includes(r.id)), ...ids.map((id) => ({ id, at }))] }));
}

/** Forget everything (e.g. the feature was turned off and on with a new provider). */
export function resetStreamHealth() {
  useStreamHealth.setState((s) => ({ urls: {}, origins: {}, recheck: [], version: s.version + 1 }));
}
