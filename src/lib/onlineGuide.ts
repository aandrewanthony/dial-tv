/**
 * Online guide: public XMLTV listings (epgshare01.online, free, updated daily) added automatically
 * for the countries in the lineup when the playlist brings no guide or its guide covers too little.
 * Guide channels are matched by name (the normal matcher), so "US: ESPN" finds "ESPN HD".
 * The user can remove it like any guide source; a removed online guide is never re-added.
 */
import { cleanChannelName, parseGroup } from './channelOrg';
import type { Channel } from '../types';

const BASE = 'https://epgshare01.online/epgshare01/epg_ripper_';

/** Country → guide file (the general file for that country; checked to exist). */
const FILES: Record<string, string> = {
  US: 'US2', CA: 'CA2', UK: 'UK1', GB: 'UK1', IE: 'IE1', AU: 'AU1', NZ: 'NZ1', MX: 'MX1', AR: 'AR1', BR: 'BR1', CL: 'CL1', CO: 'CO1',
  PE: 'PE1', EC: 'EC1', DO: 'DO1', PA: 'PA1', CR: 'CR1', ES: 'ES1', PT: 'PT1', FR: 'FR1', DE: 'DE1', AT: 'AT1', CH: 'CH1', IT: 'IT1',
  NL: 'NL1', BE: 'BE2', DK: 'DK1', NO: 'NO1', FI: 'FI1', PL: 'PL1', CZ: 'CZ1', HU: 'HU1', RO: 'RO1', GR: 'GR1', HR: 'HR1', RS: 'RS1',
  BG: 'BG1', IN: 'IN1', PK: 'PK1', PH: 'PH1', MY: 'MY1', ID: 'ID1', JP: 'JP1', KR: 'KR1', HK: 'HK1', IL: 'IL1', AE: 'AE1', EG: 'EG1',
  NG: 'NG1', KE: 'KE1', JM: 'JM1', LT: 'LT1', LV: 'LV1', LU: 'LU1', MT: 'MT1', CY: 'CY1', AL: 'AL1', BA: 'BA1', KZ: 'KZ1',
};

export const onlineGuideUrl = (country: string) => (FILES[country] ? `${BASE}${FILES[country]}.xml.gz` : undefined);
export const isOnlineGuideUrl = (url?: string) => !!url && url.startsWith(BASE);
export const ONLINE_ID = (country: string) => `online-${country}`;

/** The lineup's main countries: up to 2 with at least 10% of live channels (or the locale's country). */
export function lineupCountries(channels: Channel[], fallback?: string): string[] {
  const counts = new Map<string, number>();
  let n = 0;
  for (const c of channels) {
    if (c.kind && c.kind !== 'live') continue;
    if (++n > 20_000) break;
    const country = cleanChannelName(c.name).country ?? parseGroup(c.group ?? '').country;
    if (country) counts.set(country, (counts.get(country) ?? 0) + 1);
  }
  const top = [...counts.entries()].filter(([cc, k]) => k >= n * 0.1 && FILES[cc]).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([cc]) => cc);
  if (top.length) return top;
  return fallback && FILES[fallback] ? [fallback] : ['US'];
}
