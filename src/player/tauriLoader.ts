/* eslint-disable @typescript-eslint/no-explicit-any */
import { getFetch } from '../lib/net';

/**
 * hls.js loader that fetches through the Tauri native HTTP plugin, so streams
 * from hosts without CORS headers can play in the desktop app. Only used when
 * running inside Tauri; the browser build uses hls.js' default XHR loader.
 */
export class TauriLoader {
  context: any = null;
  stats: any;
  private ctrl?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private callbacks: any = null;

  constructor(_config: any) {
    this.stats = {
      aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    };
  }

  load(context: any, config: any, callbacks: any) {
    this.context = context;
    this.callbacks = callbacks;
    this.ctrl = new AbortController();
    const stats = this.stats;
    stats.loading.start = performance.now();
    const headers: Record<string, string> = {};
    if (context.rangeEnd) headers.Range = `bytes=${context.rangeStart ?? 0}-${context.rangeEnd - 1}`;
    const timeout = config?.loadPolicy?.maxLoadTimeMs ?? config?.timeout ?? 20000;
    this.timer = setTimeout(() => {
      this.ctrl?.abort();
      callbacks.onTimeout?.(stats, context, null);
    }, timeout);

    getFetch()
      .then((f) => f(context.url, { headers, signal: this.ctrl!.signal }))
      .then(async (res) => {
        stats.loading.first = performance.now();
        if (!res.ok) {
          clearTimeout(this.timer);
          callbacks.onError({ code: res.status, text: res.statusText || `HTTP ${res.status}` }, context, res, stats);
          return;
        }
        const data = context.responseType === 'arraybuffer' ? await res.arrayBuffer() : await res.text();
        clearTimeout(this.timer);
        const len = typeof data === 'string' ? data.length : data.byteLength;
        stats.loaded = stats.total = len;
        stats.loading.end = performance.now();
        callbacks.onSuccess({ url: res.url || context.url, data, code: res.status }, stats, context, res);
      })
      .catch((err) => {
        clearTimeout(this.timer);
        if (stats.aborted) return;
        callbacks.onError({ code: 0, text: String(err?.message ?? err) }, context, null, stats);
      });
  }

  abort() {
    clearTimeout(this.timer);
    if (this.stats.loading.end) return;
    this.stats.aborted = true;
    this.ctrl?.abort();
    this.callbacks?.onAbort?.(this.stats, this.context, null);
  }

  destroy() {
    this.abort();
    this.callbacks = null;
    this.context = null;
  }
}
