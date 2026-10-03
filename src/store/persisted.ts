import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { kv } from './db';

/**
 * A small zustand store that saves itself to IndexedDB under its own key, so each feature
 * (TV library, bets, fantasy, scheduler...) owns its data without touching the main app store.
 * `migrate` receives whatever was stored (any older version) and must return the current shape.
 */
export function createPersisted<T extends object>(opts: {
  key: string;
  version: number;
  defaults: () => T;
  migrate?: (stored: unknown, fromVersion: number) => T;
}): UseBoundStore<StoreApi<T & { hydrated: boolean }>> & { ready: Promise<void> } {
  const storageKey = `feature:${opts.key}`;
  const store = create<T & { hydrated: boolean }>(() => ({ ...opts.defaults(), hydrated: false }));
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  (async () => {
    let loaded = false;
    try {
      const raw = await kv.get<{ v: number; data: unknown }>(storageKey);
      if (raw && typeof raw === 'object') {
        const data = raw.v === opts.version ? (raw.data as T) : opts.migrate ? opts.migrate(raw.data, raw.v) : opts.defaults();
        store.setState({ ...opts.defaults(), ...data, hydrated: true } as T & { hydrated: boolean });
      } else {
        store.setState({ hydrated: true } as Partial<T & { hydrated: boolean }>);
      }
      loaded = true;
    } catch {
      // Storage unreadable: run on defaults but never overwrite what's stored.
      store.setState({ hydrated: true } as Partial<T & { hydrated: boolean }>);
    }
    resolveReady();
    if (!loaded) return;
    let pending = false;
    const save = () => {
      pending = false;
      const { hydrated: _h, ...data } = store.getState() as T & { hydrated: boolean };
      // Functions (actions) aren't storable; drop them.
      const plain = Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v !== 'function'));
      void kv.set(storageKey, { v: opts.version, data: plain });
    };
    store.subscribe(() => {
      if (pending) return;
      pending = true;
      queueMicrotask(save);
    });
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => pending && save());
  })();

  return Object.assign(store, { ready });
}
