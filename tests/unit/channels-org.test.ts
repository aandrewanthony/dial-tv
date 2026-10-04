import { describe, expect, it } from 'vitest';
import {
  applyPrefs, categoryFromName, cleanChannelName, organize, parseGroup, qualityLabel, qualityScore, type OrgPrefs,
} from '../../src/lib/channelOrg';
import { orderedChannels } from '../../src/store/app';
import { DEFAULT_CHANNEL_PREFS } from '../../src/store/channelPrefs';
import type { Channel } from '../../src/types';

let seq = 0;
const ch = (name: string, group = '', extra: Partial<Channel> = {}): Channel => ({
  id: `c${++seq}`, number: 100 + seq, name, group, mark: '', url: `https://s/${seq}`, sourceId: 'p1', ...extra,
});
const PREFS: OrgPrefs = { hiddenGroups: [], groupOrder: [], groupNames: {}, variantChoice: {}, renumber: false };
const opts = { merge: true, maxRes: 'auto' as const, homeCountry: 'US' };

describe('channel name cleaning', () => {
  const cases: [string, string, string | undefined, string][] = [
    // raw, clean, country, quality label
    ['US| ESPN', 'ESPN', 'US', ''],
    ['US| ESPN FHD', 'ESPN', 'US', 'FHD'],
    ['US| ESPN 4K', 'ESPN', 'US', '4K'],
    ['US| ESPN (Backup)', 'ESPN', 'US', 'Backup'],
    ['US | ESPN HD', 'ESPN', 'US', 'HD'],
    ['UK: Sky Sports Main Event HD', 'Sky Sports Main Event', 'UK', 'HD'],
    ['[CA] TSN 1', 'TSN 1', 'CA', ''],
    ['|FR| TF1 HEVC', 'TF1', 'FR', 'HEVC'],
    ['US - CNN', 'CNN', 'US', ''],
    ['(DE) Das Erste ᴴᴰ', 'Das Erste', 'DE', 'HD'],
    ['ESPNᵁᴴᴰ', 'ESPN', undefined, '4K'],
    ['USA: Fox News Channel SD', 'Fox News Channel', 'US', 'SD'],
    ['VIP| US: HBO 2 FHD', 'HBO 2', 'US', 'FHD'],
    ['4K| NBA TV', 'NBA TV', undefined, '4K'],
    ['ES: DAZN 1 1080p', 'DAZN 1', 'ES', 'FHD'],
    ['UK: BT Sport 1 Backup 2', 'BT Sport 1', 'UK', 'Backup'],
    ['BBC One (UK)', 'BBC One', 'UK', ''],
    ['IT ▎Rai 1 H265', 'Rai 1', 'IT', 'HEVC'],
    ['🇺🇸 ESPN 2', 'ESPN 2', 'US', ''],
    ['LATINO| ESPN Deportes 60FPS', 'ESPN Deportes', 'LATINO', ''],
    ['US| NFL Network [FHD]', 'NFL Network', 'US', 'FHD'],
    ['US| CBS (Alt 2)', 'CBS', 'US', 'Backup'],
    // Must stay as they are
    ['FOX (WNYW) New York', 'FOX (WNYW) New York', undefined, ''],
    ['CBS East HD', 'CBS East', undefined, 'HD'],
    ['A&E', 'A&E', undefined, ''],
    ['E!', 'E!', undefined, ''],
    ['ESPN-2', 'ESPN-2', undefined, ''],
    ['TV: Something', 'TV: Something', undefined, ''],
    ['Dial News', 'Dial News', undefined, ''],
    ['HDNet Movies', 'HDNet Movies', undefined, ''],
    ['Go: Comedy', 'Go: Comedy', undefined, ''],
  ];
  it.each(cases)('%s → %s', (raw, clean, country, q) => {
    const r = cleanChannelName(raw);
    expect(r.name).toBe(clean);
    expect(r.country).toBe(country);
    expect(qualityLabel(r.quality)).toBe(q);
  });

  it('never returns an empty name', () => {
    expect(cleanChannelName('HD').name).toBe('HD');
    expect(cleanChannelName('US| ').name).toBeTruthy();
  });
});

describe('quality ranking', () => {
  const q = (s: string) => cleanChannelName(`US| X ${s}`).quality;
  it('prefers FHD/HD over 4K by default, SD and backups last', () => {
    const order = ['4K', 'SD', '(Backup)', 'HD', 'FHD', ''].sort((a, b) => qualityScore(q(a)) - qualityScore(q(b)));
    expect(order).toEqual(['FHD', 'HD', '', '4K', 'SD', '(Backup)']);
  });
  it('respects the max resolution setting', () => {
    expect(qualityScore(q('4K'), '2160')).toBeLessThan(qualityScore(q('FHD'), '2160'));
    expect(qualityScore(q('FHD'), '720')).toBeGreaterThan(qualityScore(q('SD'), '720'));
    expect(qualityScore(q('HD'), '720')).toBeLessThan(qualityScore(q(''), '720'));
  });
  it('HEVC loses ties', () => {
    expect(qualityScore(q('FHD HEVC'))).toBeGreaterThan(qualityScore(q('FHD')));
  });
});

describe('group normalization', () => {
  it.each([
    ['US| SPORTS', 'US', 'Sports'],
    ['UK - Sports', 'UK', 'Sports'],
    ['[CA] News', 'CA', 'News'],
    ['FR: Movies', 'FR', 'Movies'],
    ['USA ENTERTAINMENT', 'US', 'Entertainment'],
    ['US| LOCALS', 'US', 'Locals'],
    ['Canada Kids', 'CA', 'Kids'],
    ['DE| Dokumentation', 'DE', 'Documentary'],
    ['LATINO| DEPORTES', 'LATINO', 'Sports'],
    ['Sports', undefined, 'Sports'],
    ['US| VIP', 'US', undefined],
    ['Music Hits (UK)', 'UK', 'Music'],
    ['Religious', undefined, 'Religious'],
  ])('%s → %s / %s', (g, country, cat) => {
    const r = parseGroup(g);
    expect(r.country).toBe(country);
    expect(r.category).toBe(cat);
  });

  it('derives categories from channel names when the group says nothing', () => {
    expect(categoryFromName('ESPN 2')).toBe('Sports');
    expect(categoryFromName('Fox News')).toBe('News');
    expect(categoryFromName('FOX (WNYW) New York')).toBe('Locals');
    expect(categoryFromName('ABC 7 Chicago')).toBe('Locals');
    expect(categoryFromName('Cartoon Network')).toBe('Kids');
    expect(categoryFromName('HBO 2')).toBe('Movies');
    expect(categoryFromName('MTV')).toBe('Music');
    expect(categoryFromName('National Geographic')).toBe('Documentary');
    expect(categoryFromName('TBN')).toBe('Religious');
    expect(categoryFromName('AMC')).toBe('Entertainment');
    expect(categoryFromName('Wild West Shows')).toBeUndefined();
  });
});

describe('merging duplicates', () => {
  it('merges same tvg-id + country into one channel, best quality primary, rest as fallbacks', () => {
    const list = [
      ch('US| ESPN', 'US| SPORTS', { tvgId: 'ESPN.us' }),
      ch('US| ESPN 4K', 'US| SPORTS', { tvgId: 'ESPN.us' }),
      ch('US| ESPN FHD', 'US - Sports', { tvgId: 'ESPN.us' }),
      ch('US| ESPN (Backup)', 'US| SPORTS'), // no tvg-id: joins by clean name + country
      ch('UK| ESPN', 'UK| SPORTS', { tvgId: 'ESPN.uk' }),
    ];
    const org = organize(list, opts);
    expect(org.all).toHaveLength(2);
    const us = org.all[0];
    expect(us.id).toBe(list[0].id); // first entry with a tvg-id keeps guide listings working
    expect(us.tvgId).toBe('ESPN.us');
    expect(us.displayName).toBe('ESPN');
    expect(us.name).toBe('ESPN (US)'); // same clean name exists in the UK
    expect(us.url).toBe(list[2].url); // FHD preferred
    expect(us.fallbackUrls).toEqual([list[0].url, list[1].url, list[3].url]);
    expect(us.variants.map((v) => v.label)).toEqual(['FHD', 'Standard', '4K', 'Backup']);
    expect(us.memberIds).toHaveLength(4);
    expect(org.alias.get(list[1].id)).toBe(us.id);
    expect(us.groupKey).toBe('US|Sports');
    expect(org.groups.map((g) => g.key)).toEqual(['US|Sports', 'UK|Sports']);
  });

  it('keeps local affiliates that share an EPG id apart (name guard)', () => {
    const org = organize([ch('US| ABC New York', 'US| LOCALS', { tvgId: 'ABC.us' }), ch('US| ABC Chicago', 'US| LOCALS', { tvgId: 'ABC.us' })], opts);
    expect(org.all).toHaveLength(2);
  });

  it('does not merge across playlists or when merging is off', () => {
    const a = ch('US| CNN', 'US| NEWS', { tvgId: 'CNN.us' });
    const b = ch('US| CNN HD', 'US| NEWS', { tvgId: 'CNN.us', sourceId: 'p2' });
    expect(organize([a, b], opts).all).toHaveLength(2);
    const c = ch('US| CNN HD', 'US| NEWS', { tvgId: 'CNN.us' });
    expect(organize([a, c], opts).all).toHaveLength(1);
    const off = organize([a, c], { ...opts, merge: false });
    expect(off.all).toHaveLength(2);
    expect(off.all.map((x) => x.displayName)).toEqual(['CNN', 'CNN']);
  });

  it('honors max resolution when picking the primary', () => {
    const list = [ch('US| TNT FHD', 'US| SPORTS', { tvgId: 'TNT.us' }), ch('US| TNT 4K', 'US| SPORTS', { tvgId: 'TNT.us' })];
    expect(organize(list, { ...opts, maxRes: '2160' }).all[0].url).toBe(list[1].url);
    expect(organize(list, opts).all[0].url).toBe(list[0].url);
  });

  it('is memoized per channels array', () => {
    const list = [ch('US| A'), ch('US| B')];
    expect(organize(list, opts)).toBe(organize(list, opts));
    expect(organize(list, { ...opts, merge: false })).not.toBe(organize(list, opts));
  });

  it('skips movies and series', () => {
    const org = organize([ch('Heat (1995)', 'VOD', { kind: 'movie' }), ch('CNN', 'News')], opts);
    expect(org.all.map((c) => c.displayName)).toEqual(['CNN']);
  });
});

describe('preferences', () => {
  const list = [
    ch('US| ESPN', 'US| SPORTS', { tvgId: 'ESPN.us' }),
    ch('US| ESPN 4K', 'US| SPORTS', { tvgId: 'ESPN.us' }),
    ch('US| CNN', 'US| NEWS', { tvgId: 'CNN.us' }),
    ch('UK| Sky News', 'UK| NEWS', { tvgId: 'SkyNews.uk' }),
    ch('US| HBO', 'US| MOVIES', { tvgId: 'HBO.us' }),
  ];
  const org = organize(list, opts);
  const names = (xs: { displayName: string }[]) => xs.map((x) => x.displayName);

  it('hides groups, orders groups, renames and renumbers', () => {
    const ctx = { channelOrder: [], hidden: [] };
    expect(names(applyPrefs(org, PREFS, ctx))).toEqual(['ESPN', 'CNN', 'HBO', 'Sky News']); // home country first
    const p: OrgPrefs = { ...PREFS, hiddenGroups: ['US|Movies'], groupOrder: ['UK|News', 'US|News'], groupNames: { 'US|News': 'Headlines' }, renumber: true };
    const out = applyPrefs(org, p, ctx);
    expect(names(out)).toEqual(['Sky News', 'CNN', 'ESPN']);
    expect(out.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(out[1].group).toBe('Headlines');
    const all = applyPrefs(org, p, { ...ctx, includeHidden: true });
    expect(all).toHaveLength(4);
    expect(all.find((c) => c.displayName === 'HBO')!.number).not.toBe(4); // hidden channels don't take numbers
  });

  it('applies the chosen quality variant and drops individually hidden variants', () => {
    const espn = org.all[0];
    const chosen = applyPrefs(org, { ...PREFS, variantChoice: { [espn.id]: list[1].id } }, { channelOrder: [], hidden: [] })[0];
    expect(chosen.url).toBe(list[1].url);
    expect(chosen.qualityLabel).toBe('4K');
    expect(chosen.fallbackUrls).toEqual([list[0].url]);
    const dropped = applyPrefs(org, PREFS, { channelOrder: [], hidden: [list[1].id] })[0];
    expect(dropped.variants).toHaveLength(1);
    expect(dropped.fallbackUrls).toBeUndefined();
  });

  it('custom channel order applies inside a group', () => {
    const extra = [ch('US| FS1', 'US| SPORTS', { tvgId: 'FS1.us' }), ch('US| FS2', 'US| SPORTS', { tvgId: 'FS2.us' })];
    const o = organize([...list, ...extra], opts);
    const out = applyPrefs(o, PREFS, { channelOrder: [extra[1].id], hidden: [] });
    expect(names(out).slice(0, 3)).toEqual(['FS2', 'ESPN', 'FS1']);
  });

  it('orderedChannels returns merged channels and honors hidden groups from prefs', () => {
    const s = { channels: list, channelOrder: [], hidden: [], settings: { playback: { maxResolution: 'auto' } } } as never;
    expect(orderedChannels(s, false, { ...DEFAULT_CHANNEL_PREFS })).toHaveLength(4);
    expect(names(orderedChannels(s, false, { ...DEFAULT_CHANNEL_PREFS, hiddenGroups: ['US|Sports', 'UK|News'] }))).toEqual(['CNN', 'HBO']);
    expect(orderedChannels(s, false, { ...DEFAULT_CHANNEL_PREFS, mergeDuplicates: false })).toHaveLength(5);
  });
});

describe('performance', () => {
  it('organizes 30k entries in under 300 ms (uncached, best of 5)', () => {
    const countries = ['US', 'UK', 'CA', 'FR', 'DE', 'ES', 'IT', 'AR', 'IN', 'PT', 'NL', 'TR', 'PL', 'LATINO'];
    const cats = ['SPORTS', 'News', 'Entertainment', 'Movies', 'Kids', 'Locals', 'VIP'];
    const styles = [(c: string, k: string) => `${c}| ${k}`, (c: string, k: string) => `${c} - ${k}`, (c: string, k: string) => `[${c}] ${k}`, (c: string, k: string) => `${c}: ${k}`];
    const qual = ['', ' HD', ' FHD', ' 4K', ' HEVC', ' (Backup)', ' SD'];
    // Fresh names every run so the name/group caches don't help.
    const build = (run: number) => {
      const list: Channel[] = [];
      for (let i = 0; list.length < 30_000; i++) {
        const c = countries[i % countries.length];
        const base = `Channel ${run}x${Math.floor(i / 3)}`;
        for (let k = 0; k < 1 + (i % 4); k++) {
          const name = `${c}| ${base}${qual[(i + k) % qual.length]}`;
          list.push({ id: `x${list.length}`, number: list.length, name, group: `${styles[i % 4](c, cats[i % cats.length])} ${run}`, mark: '', url: `https://s/${list.length}`, tvgId: `${base}.${c}`.replace(/ /g, ''), sourceId: 'p' });
        }
      }
      return list;
    };
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const list = build(run);
      const t0 = performance.now();
      const c0 = process.cpuUsage();
      const org = organize(list, { merge: true, maxRes: 'auto', homeCountry: 'US' });
      const out = applyPrefs(org, PREFS, { channelOrder: [], hidden: [] });
      // CPU time of this worker (wall time inflates when the other test files run in parallel), capped by wall time.
      const cpu = process.cpuUsage(c0);
      best = Math.min(best, (cpu.user + cpu.system) / 1000, performance.now() - t0);
      expect(out.length).toBeLessThan(list.length);
      expect(org.groups.length).toBeLessThan(120);
    }
    expect(best).toBeLessThan(300);
  });
});
