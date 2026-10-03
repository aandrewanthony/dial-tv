/**
 * Minimal promise-based IndexedDB key/value store.
 * IndexedDB is durable in browsers and in the Tauri/Electron webview, so one implementation
 * serves web + desktop. localStorage is used only when IndexedDB does not exist at all —
 * never as a silent fallback for a failed IndexedDB read/write, because a stale localStorage
 * copy would later shadow (or be shadowed by) the real data.
 */

const DB_NAME = 'dial-tv';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

/** Thrown by kv.get/kv.put when storage exists but the operation failed (vs. a missing key → undefined). */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly quota = false,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

const hasIdb = () => typeof indexedDB !== 'undefined';

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(r.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

function wrap(e: unknown, op: string): StorageError {
  if (e instanceof StorageError) return e;
  const name = (e as { name?: string } | null)?.name ?? '';
  const quota = name === 'QuotaExceededError' || /quota/i.test(String((e as Error | null)?.message ?? ''));
  return new StorageError(quota ? 'Storage is full' : `Storage ${op} failed: ${(e as Error | null)?.message ?? e}`, quota);
}

const LS_PREFIX = 'dial-tv:';

export const kv = {
  /** Value for `key`, or undefined when missing. Rejects with StorageError when the read itself fails. */
  async get<T>(key: string): Promise<T | undefined> {
    if (!hasIdb()) {
      try {
        const v = localStorage.getItem(LS_PREFIX + key);
        return v ? (JSON.parse(v) as T) : undefined;
      } catch (e) {
        throw wrap(e, 'read');
      }
    }
    try {
      return (await tx('readonly', (s) => s.get(key))) as T | undefined;
    } catch (e) {
      throw wrap(e, 'read');
    }
  },
  /** Write; rejects with StorageError (quota=true when full). */
  async put<T>(key: string, value: T): Promise<void> {
    try {
      if (!hasIdb()) localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      else await tx('readwrite', (s) => s.put(value, key));
    } catch (e) {
      throw wrap(e, 'write');
    }
  },
  /** Best-effort write: never throws; resolves false when the write failed. */
  async set<T>(key: string, value: T): Promise<boolean> {
    try {
      await kv.put(key, value);
      return true;
    } catch {
      return false;
    }
  },
  async clear(): Promise<void> {
    if (hasIdb()) {
      try {
        await tx('readwrite', (s) => s.clear());
      } catch {
        /* ignore */
      }
    }
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(LS_PREFIX) || k === 'dial-schedule') localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
  async del(key: string): Promise<void> {
    try {
      if (!hasIdb()) localStorage.removeItem(LS_PREFIX + key);
      else await tx('readwrite', (s) => s.delete(key));
    } catch {
      /* ignore */
    }
  },
};
