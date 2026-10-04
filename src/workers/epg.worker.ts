/**
 * Guide worker: downloads, decompresses and parses XMLTV off the main thread, then writes the
 * compact guide cache to IndexedDB and hands it back (the programme table is transferred, not copied).
 *
 * in:  { type: 'load', id, req: GuideJobRequest } | { type: 'cancel', id }
 * out: { type: 'ready' } | { type: 'progress', id, p } | { type: 'done', id, cache } | { type: 'error', id, message, aborted? }
 */
import { runGuideJob, type GuideJobRequest } from './guideJob';

const ctx = self as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

const jobs = new Map<number, AbortController>();

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: 'load'; id: number; req: GuideJobRequest } | { type: 'cancel'; id: number };
  if (m.type === 'cancel') {
    jobs.get(m.id)?.abort();
    return;
  }
  if (m.type !== 'load') return;
  const ac = new AbortController();
  jobs.set(m.id, ac);
  try {
    const cache = await runGuideJob(m.req, (p) => ctx.postMessage({ type: 'progress', id: m.id, p }), ac.signal);
    ctx.postMessage({ type: 'done', id: m.id, cache }, [cache.data.buffer]);
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    ctx.postMessage({ type: 'error', id: m.id, message: aborted ? 'Cancelled' : (err as Error).message || String(err), aborted });
  } finally {
    jobs.delete(m.id);
  }
};

ctx.postMessage({ type: 'ready' });
