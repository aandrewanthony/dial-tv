import type { Channel, EpgSource, PlaylistSource, Program } from '../types';
import type { EpgProvider, PlaylistProvider } from './types';
import { parseM3U } from '../lib/m3u';
import { parseXMLTV } from '../lib/xmltv';
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

/**
 * Join XMLTV programmes to playlist channels:
 * 1) tvg-id === xmltv channel id, 2) manual mapping, 3) normalized display-name match.
 */
export function mapXmltvPrograms(
  xml: string,
  channels: Channel[],
  manual: Record<string, string> = {},
): { programs: Program[]; unmatched: { id: string; name: string }[]; xmltvChannels: { id: string; name: string }[] } {
  const parsed = parseXMLTV(xml);
  const byTvg = new Map<string, Channel[]>();
  const byName = new Map<string, Channel[]>();
  for (const c of channels) {
    if (c.tvgId) byTvg.set(c.tvgId.toLowerCase(), [...(byTvg.get(c.tvgId.toLowerCase()) ?? []), c]);
    const n = normalizeName(c.name);
    byName.set(n, [...(byName.get(n) ?? []), c]);
  }
  const target = new Map<string, string[]>();
  for (const [chId, xId] of Object.entries(manual)) target.set(xId, [...(target.get(xId) ?? []), chId]);
  const unmatched: { id: string; name: string }[] = [];
  for (const xc of parsed.channels) {
    const ids = new Set(target.get(xc.id) ?? []);
    for (const c of byTvg.get(xc.id.toLowerCase()) ?? []) ids.add(c.id);
    if (!ids.size) for (const n of xc.names) for (const c of byName.get(normalizeName(n)) ?? []) ids.add(c.id);
    if (ids.size) target.set(xc.id, [...ids]);
    else unmatched.push({ id: xc.id, name: xc.names[0] ?? xc.id });
  }
  const programs: Program[] = [];
  for (const p of parsed.programs) {
    for (const chId of target.get(p.xmltvChannel) ?? []) {
      const { xmltvChannel: _x, ...rest } = p;
      programs.push({ ...rest, id: `${chId}|${p.start}`, channelId: chId });
    }
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
