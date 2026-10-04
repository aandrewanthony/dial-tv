/**
 * Guide cache storage: its own IndexedDB database so the (large) guide never bloats or blocks the
 * app's key/value store. Usable from the main thread and from the guide worker.
 */
import type { GuideCache } from './epgCore';

const DB = 'dial-tv-guide';
const STORE = 'guide';
const KEY = 'cache';

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbp.catch(() => (dbp = null));
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(r.result as T);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const hasIdb = () => typeof indexedDB !== 'undefined';

export async function readGuideCache(): Promise<GuideCache | undefined> {
  if (!hasIdb()) return undefined;
  const v = await run<GuideCache | undefined>('readonly', (s) => s.get(KEY));
  return v && v.v === 1 && ArrayBuffer.isView(v.data) ? v : undefined;
}

export async function writeGuideCache(c: GuideCache): Promise<void> {
  if (!hasIdb()) return;
  await run('readwrite', (s) => s.put(c, KEY));
}

export async function clearGuideCache(): Promise<void> {
  if (!hasIdb()) return;
  await run('readwrite', (s) => s.delete(KEY));
}

/**
 * Read an imported guide file saved by the app (key `file:<id>` in the app's kv store): a Blob/File
 * (new imports) or a string (older imports).
 */
export function readAppFile(id: string): Promise<Blob | string | undefined> {
  if (!hasIdb()) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dial-tv', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const t = db.transaction('kv', 'readonly');
        const g = t.objectStore('kv').get(`file:${id}`);
        t.oncomplete = () => {
          db.close();
          resolve(g.result as Blob | string | undefined);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      } catch (e) {
        db.close();
        reject(e);
      }
    };
  });
}

/** Small guide settings record (kept with the guide so it never touches the app's kv store). */
export async function readGuidePrefs<T>(): Promise<T | undefined> {
  if (!hasIdb()) return undefined;
  return run<T | undefined>('readonly', (s) => s.get('prefs'));
}

export async function writeGuidePrefs<T>(v: T): Promise<void> {
  if (!hasIdb()) return;
  await run('readwrite', (s) => s.put(v, 'prefs'));
}
