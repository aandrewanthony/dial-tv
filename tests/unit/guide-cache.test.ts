import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decodeGuide, GuideCollector, guideWindow, rowFields, STRIDE } from '../../src/workers/epgCore';
import { runGuideJob } from '../../src/workers/guideJob';
import { readGuideCache } from '../../src/workers/guideDb';
import { defaultPersisted, nowPlaying, programsByChannel, programsInRange, upNext, useApp } from '../../src/store/app';
import { guideDebug, guideStatusText, initGuide, loadGuide, maybeAutoRefresh, resetAutoRefresh, useGuide, useGuidePrefs } from '../../src/store/guide';
import { programAt, programIndex } from '../../src/components/ui';
import type { Channel } from '../../src/types';

const H = 3600_000;
const fmt = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
};
const T0 = Math.floor(Date.now() / H) * H;
const prog = (ch: string, start: number, stop: number | null, title: string, extra = '') =>
  `<programme channel="${ch}" start="${fmt(start)}"${stop != null ? ` stop="${fmt(stop)}"` : ''}><title>${title}</title>${extra}</programme>`;

function guideXml() {
  return `<?xml version="1.0"?><tv>
    <channel id="espn.us"><display-name>ESPN</display-name></channel>
    <channel id="cnn.us"><display-name>CNN</display-name></channel>
    <channel id="nobody.us"><display-name>Nobody Watches</display-name></channel>
    ${prog('espn.us', T0 - 30 * H, T0 - 29 * H, 'Way back')}
    ${prog('espn.us', T0 - H, T0 + H, 'Live Game', '<category>Sports</category><desc>Big one</desc>')}
    ${prog('espn.us', T0 + H, null, 'Open Show')}
    ${prog('espn.us', T0 + 3 * H, T0 + 4 * H, 'Late Show')}
    ${prog('espn.us', T0 + 20 * 24 * H, T0 + 20 * 24 * H + H, 'Far future')}
    ${prog('cnn.us', T0 - H, T0 + 2 * H, 'News Now')}
    ${prog('nobody.us', T0, T0 + H, 'Unwatched')}
  </tv>`;
}

const ch = (id: string, name: string, tvgId?: string): Channel => ({ id, name, tvgId, number: 1, group: 'G', mark: 'X', url: `https://s/${id}`, sourceId: 'pl' });

describe('guide job: windowing, skipping, compact cache', () => {
  it('keeps only matched channels inside the window, once per guide channel', async () => {
    const cache = await runGuideJob(
      {
        sources: [{ id: 'g1', text: guideXml() }, { id: 'g2', text: `<tv><channel id="espn.us"><display-name>ESPN</display-name></channel>${prog('espn.us', T0, T0 + H, 'Duplicate source')}</tv>` }],
        channels: [{ id: 'p1', name: 'US| ESPN HD', tvgId: 'espn.us' }, { id: 'p2', name: 'US| ESPN FHD', tvgId: 'ESPN.US' }, { id: 'p3', name: 'CNN' }],
        manual: {},
        days: 3,
        now: T0,
        save: false,
      },
      () => undefined,
    );
    const g = decodeGuide(cache);
    expect(cache.scanned).toBe(8);
    const titles = Array.from({ length: g.count }, (_, r) => rowFields(g, r).title);
    // Windowed (no "Way back" / "Far future"), unmatched channel skipped, second source ignored for espn.
    expect(titles.sort()).toEqual(['Late Show', 'Live Game', 'News Now', 'Open Show']);
    expect(g.count * STRIDE).toBe(cache.data.length);
    const espn = g.channels.findIndex((c) => c.id === 'espn.us');
    const [a, b] = g.ranges.get(espn)!;
    const rows = Array.from({ length: b - a }, (_, i) => rowFields(g, a + i));
    expect(rows.map((r) => r.title)).toEqual(['Live Game', 'Open Show', 'Late Show']);
    // Open-ended programme runs until the next one.
    expect(rows[1].end).toBe(T0 + 3 * H);
    expect(rows[0]).toMatchObject({ isSports: true, description: 'Big one', category: 'Sports' });
    expect(cache.sources.map((s) => s.programmes)).toEqual([4, 0]);
    // Every EPG channel is listed for the mapping picker, even unmatched ones.
    expect(g.channels.map((c) => c.id)).toContain('nobody.us');
  });

  it('round-trips through the compact encoding', () => {
    const w = guideWindow(T0, 2);
    const col = new GuideCollector(w.from, w.to);
    col.addChannel({ id: 'c', names: ['C'] });
    col.add({ channel: 'c', start: T0 + H, stop: T0 + 2 * H, title: 'B\u0000x', categories: [], isNew: true }, 0);
    col.add({ channel: 'c', start: T0, stop: T0 + H, title: 'A', subtitle: 'sub', desc: 'd', categories: ['Football'], isNew: false }, 0);
    const cache = col.finish({ savedAt: 1, days: 2, sources: [{ id: 's', programmes: 0, channels: 0 }] });
    const g = decodeGuide(cache);
    expect([rowFields(g, 0), rowFields(g, 1)]).toEqual([
      { start: T0, end: T0 + H, title: 'A', subtitle: 'sub', description: 'd', category: 'Football', isSports: true, isNew: false },
      { start: T0 + H, end: T0 + 2 * H, title: 'Bx', subtitle: undefined, description: undefined, category: 'General', isSports: false, isNew: true },
    ]);
    expect(w.days).toBe(2);
    expect(guideWindow(T0, 99).days).toBe(7);
  });
});

describe('guide store', () => {
  let fetches: string[] = [];
  beforeEach(() => {
    fetches = [];
    guideDebug.noWorker = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetches.push(url);
      return new Response(gzipSync(guideXml()), { headers: { 'content-type': 'application/gzip' } });
    }));
    useApp.setState({
      ...defaultPersisted(),
      hydrated: true,
      channels: [ch('pl:espn-hd', 'US| ESPN HD', 'espn.us'), ch('pl:espn-fhd', 'US| ESPN FHD', 'espn.us'), ch('pl:cnn', 'US: CNN'), ch('pl:other', 'Other')],
      epgSources: [{ id: 'g', name: 'Guide', kind: 'xmltv-url', url: 'https://g/epg.xml.gz', enabled: true }],
      programs: [],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('loads by itself online, stores programmes once, serves every playlist channel id, restarts from cache', async () => {
    resetAutoRefresh();
    expect(guideStatusText(useGuide.getState())).toBe('Getting the guide…');
    await initGuide(); // no saved guide: downloads in the background right away
    for (let i = 0; i < 100 && !useGuide.getState().loaded; i++) await new Promise((r) => setTimeout(r, 20));
    expect(fetches).toEqual(['https://g/epg.xml.gz']);
    const s = useApp.getState();
    // 4 programmes for 3 matched playlist channels: stored once, not copied per channel.
    expect(s.programs).toHaveLength(4);
    // Counts are of the channels the user sees (ESPN HD + FHD merge into one ESPN): 2 of 3.
    expect(useGuide.getState()).toMatchObject({ loaded: true, programmes: 4, matched: 2, liveChannels: 3, days: 3 });
    expect(guideStatusText(useGuide.getState())).toMatch(/^Guide loaded .+ · 2 of 3 channels matched · 3 days$/);
    expect(nowPlaying(s.programs, 'pl:espn-hd', T0)?.title).toBe('Live Game');
    expect(nowPlaying(s.programs, 'pl:espn-fhd', T0)?.title).toBe('Live Game');
    expect(upNext(s.programs, 'pl:espn-fhd', T0)?.title).toBe('Open Show');
    expect(programsInRange(s.programs, 'pl:cnn', T0, T0 + H).map((p) => p.title)).toEqual(['News Now']);
    expect(programsByChannel(s.programs).get('pl:espn-hd')).toBe(programsByChannel(s.programs).get('pl:espn-fhd'));
    expect(programAt(programIndex(s.programs).get('pl:espn-fhd'), T0)?.title).toBe('Live Game');
    expect(nowPlaying(s.programs, 'pl:other', T0)).toBeUndefined();
    expect(s.epgSources[0]).toMatchObject({ programCount: 4, error: undefined });

    const stored = await readGuideCache();
    expect(stored && decodeGuide(stored).count).toBe(4);

    // "Restart": state rebuilt from the cache, no network.
    useApp.setState({ programs: [] });
    await initGuide();
    expect(fetches).toHaveLength(1);
    expect(nowPlaying(useApp.getState().programs, 'pl:espn-fhd', T0)?.title).toBe('Live Game');

    // Manual mapping re-maps from the cache instantly.
    useApp.getState().update(() => ({ epgManual: { 'pl:other': 'cnn.us' } }));
    await new Promise((r) => setTimeout(r, 80));
    expect(nowPlaying(useApp.getState().programs, 'pl:other', T0)?.title).toBe('News Now');
    expect(useGuide.getState().matched).toBe(3);

    // Disabling the source hides its listings without downloading.
    useApp.getState().update((st) => ({ epgSources: st.epgSources.map((e) => ({ ...e, enabled: false })) }));
    await new Promise((r) => setTimeout(r, 80));
    expect(useApp.getState().programs).toHaveLength(0);
    expect(fetches).toHaveLength(1);
  });

  it('reports a failed download and keeps the previous guide', async () => {
    await initGuide();
    await loadGuide();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    expect(await loadGuide({ background: true })).toBe(false);
    expect(useGuide.getState().error).toBe('HTTP 404');
    expect(useApp.getState().programs.length).toBe(4);
  });

  it('refresh policy: "Once a day" downloads once when the cache is older than a day, never more than every 15 min', async () => {
    await initGuide();
    await loadGuide();
    const n = fetches.length;
    useGuidePrefs.setState({ refresh: 'daily' });
    resetAutoRefresh();
    useGuide.setState({ loadedAt: Date.now() - 2 * H, until: Date.now() + 48 * H });
    maybeAutoRefresh(); // fresh enough
    expect(fetches).toHaveLength(n);
    useGuide.setState({ loadedAt: Date.now() - 25 * H });
    maybeAutoRefresh();
    maybeAutoRefresh(); // coalesced
    await new Promise((r) => setTimeout(r, 50));
    expect(fetches).toHaveLength(n + 1);
    useGuide.setState({ loadedAt: Date.now() - 25 * H, until: Date.now() + 48 * H });
    maybeAutoRefresh(); // tried less than 15 min ago
    expect(fetches).toHaveLength(n + 1);
    useGuidePrefs.setState({ refresh: '12h' });
  });
});
