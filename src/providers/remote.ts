import type { Channel, EpgSource, PlaylistSource, Program } from '../types';
import type { EpgProvider, PlaylistProvider } from './types';
import { parseM3U } from '../lib/m3u';
import { parseXMLTV, type XmltvWindow } from '../lib/xmltv';
import { fetchText } from '../lib/net';
import { normalizeName } from '../lib/channelMatch';

export function m3uUrlProvider(src: PlaylistSource, numberStart: number): PlaylistProvider {
  return {
    id: src.id,
    async load(signal) {
      if (!src.url) throw new Error('No URL');
      const r = parseM3U(await fetchText(src.url, signal), src.id, numberStart);
      return { channels: r.channels, epgUrl: r.epgUrl, skipped: r.skipped.length };
    },
  };
}

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/**
 * In-memory helper (tests, small imports). The app itself loads guides through the guide worker
 * (workers/epg.worker.ts → store/guide.ts), which stores each programme once per guide channel
 * instead of copying it onto every playlist channel like this function does.
 *
 * Join XMLTV programmes to playlist channels:
 * 1) tvg-id === xmltv channel id, 2) manual mapping, 3) normalized display-name match.
 * `window` limits programmes to a time range before they are expanded per channel.
 */
export function mapXmltvPrograms(
  xml: string,
  channels: Channel[],
  manual: Record<string, string> = {},
  window: XmltvWindow = {},
): { programs: Program[]; unmatched: { id: string; name: string }[]; xmltvChannels: { id: string; name: string }[] } {
  const parsed = parseXMLTV(xml, window);
  const byTvg = new Map<string, Channel[]>();
  const byName = new Map<string, Channel[]>();
  for (const c of channels) {
    if (c.tvgId) pushTo(byTvg, c.tvgId.toLowerCase(), c);
    const n = normalizeName(c.name);
    // An empty normalized name would match every other empty name: skip it.
    if (n) pushTo(byName, n, c);
  }
  const target = new Map<string, string[]>();
  for (const [chId, xId] of Object.entries(manual)) pushTo(target, xId, chId);
  const unmatched: { id: string; name: string }[] = [];
  for (const xc of parsed.channels) {
    const ids = new Set(target.get(xc.id) ?? []);
    for (const c of byTvg.get(xc.id.toLowerCase()) ?? []) ids.add(c.id);
    if (!ids.size) {
      for (const name of xc.names) {
        const n = normalizeName(name);
        if (!n) continue;
        for (const c of byName.get(n) ?? []) ids.add(c.id);
      }
    }
    if (ids.size) target.set(xc.id, [...ids]);
    else unmatched.push({ id: xc.id, name: xc.names[0] ?? xc.id });
  }
  const programs: Program[] = [];
  for (const p of parsed.programs) {
    const chIds = target.get(p.xmltvChannel);
    if (!chIds) continue;
    const { xmltvChannel: _x, ...rest } = p;
    for (const chId of chIds) programs.push({ ...rest, id: `${chId}|${p.start}`, channelId: chId });
  }
  return {
    programs,
    unmatched,
    xmltvChannels: parsed.channels.map((c) => ({ id: c.id, name: c.names[0] ?? c.id })),
  };
}

export function xmltvUrlProvider(src: EpgSource, manual: Record<string, string>): EpgProvider & { lastUnmatched?: number } {
  return {
    id: src.id,
    async load(channels, signal) {
      if (!src.url) throw new Error('No URL');
      return mapXmltvPrograms(await fetchText(src.url, signal), channels, manual).programs;
    },
  };
}
