/**
 * Minimal promise-based IndexedDB key/value store with a localStorage fallback.
 * IndexedDB is durable in browsers and in the Tauri webview (WebView2 / WKWebView
 * keep it in the app data directory), so one implementation serves web + desktop.
 */

const DB_NAME = 'dial-tv';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
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

const LS_PREFIX = 'dial-tv:';

export const kv = {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      return (await tx('readonly', (s) => s.get(key))) as T | undefined;
    } catch {
      try {
        const v = localStorage.getItem(LS_PREFIX + key);
        return v ? (JSON.parse(v) as T) : undefined;
      } catch {
        return undefined;
      }
    }
  },
  async set<T>(key: string, value: T): Promise<void> {
    try {
      await tx('readwrite', (s) => s.put(value, key));
    } catch {
      try {
        localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      } catch {
        /* quota or unavailable: state stays in memory */
      }
    }
  },
  async del(key: string): Promise<void> {
    try {
      await tx('readwrite', (s) => s.delete(key));
    } catch {
      try {
        localStorage.removeItem(LS_PREFIX + key);
      } catch {
        /* ignore */
      }
    }
  },
};
