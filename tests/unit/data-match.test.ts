import { describe, expect, it } from 'vitest';
import { matchBroadcasts, matchNetwork, normalizeName } from '../../src/lib/channelMatch';
import { parseXMLTV } from '../../src/lib/xmltv';
import { mapXmltvPrograms } from '../../src/providers/remote';
import type { Channel } from '../../src/types';

const ch = (id: string, name: string): Channel => ({ id, name, number: 1, group: '', mark: '', url: 'https://x', sourceId: 's' });

describe('channel matching negatives', () => {
  it('regional feeds and lookalike names do not match US networks', () => {
    expect(matchNetwork('TNT', [ch('t', 'TNT Sports 1 UK')])).toBeNull();
    expect(matchNetwork('NBA TV', [ch('n', 'NBA TV Canada')])).toBeNull();
    expect(matchNetwork('USA Net', [ch('u', 'USA Today')])).toBeNull();
    expect(matchNetwork('ESPN', [ch('e', 'ESPN Deportes Latino'), ch('e2', 'ESPN 2 Mexico')])).toBeNull();
  });
  it('still matches real affiliates and exact names', () => {
    expect(matchNetwork('CBS', [ch('c', 'CBS 2 Chicago')])!.channel.id).toBe('c');
    expect(matchNetwork('FOX', [ch('f', 'FOX (WNYW) New York')])!.channel.id).toBe('f');
    expect(matchNetwork('NBA TV', [ch('n', 'NBA TV Canada'), ch('n2', 'NBA TV HD')])!.channel.id).toBe('n2');
    expect(matchNetwork('TNT', [ch('t', 'TNT Sports 1 UK'), ch('t2', 'US: TNT')])!.channel.id).toBe('t2');
    expect(matchNetwork('USA Net', [ch('u', 'USA Network East')])!.channel.id).toBe('u');
  });
  it('memoizes per channels array and recomputes when the array changes', () => {
    const a = [ch('c', 'CBS')];
    const r1 = matchBroadcasts(['CBS'], a);
    expect(matchBroadcasts(['CBS'], a)).toBe(r1);
    const b = [ch('c2', 'CBS HD')];
    expect(matchBroadcasts(['CBS'], b)!.channel.id).toBe('c2');
    const ov = { cbs: 'c' };
    const both = [...a, ...b];
    expect(matchBroadcasts(['CBS'], both, ov)!.reason).toBe('manual');
    expect(matchBroadcasts(['CBS'], both, { cbs: 'c2' })!.channel.id).toBe('c2');
    expect(matchBroadcasts(['NBC', 'CBS'], both)!.network).toBe('CBS');
  });
});

describe('unicode names', () => {
  it('keeps non-Latin letters', () => {
    expect(normalizeName('Россия 1 HD')).toBe('россия 1');
    expect(normalizeName('الجزيرة')).not.toBe('');
  });
});

const xml = (programmes: string, channels = '') => `<?xml version="1.0"?><tv>${channels}${programmes}</tv>`;
const prog = (ch: string, start: string, stop: string | null, title: string) =>
  `<programme channel="${ch}" start="${start} +0000"${stop ? ` stop="${stop} +0000"` : ''}><title>${title}</title></programme>`;

describe('XMLTV windowing', () => {
  it('drops programmes outside [from, to) and keeps overlapping ones', () => {
    const doc = xml(
      prog('a', '20261001000000', '20261001010000', 'Old') +
      prog('a', '20261003230000', '20261004010000', 'Overlap') +
      prog('a', '20261004020000', '20261004030000', 'In') +
      prog('a', '20261020000000', '20261020010000', 'Far'),
    );
    const from = Date.UTC(2026, 9, 4, 0);
    const to = Date.UTC(2026, 9, 5, 0);
    const r = parseXMLTV(doc, { from, to });
    expect(r.programs.map((p) => p.title)).toEqual(['Overlap', 'In']);
    expect(parseXMLTV(doc).programs).toHaveLength(4);
  });

  it('open-ended programmes still run until the next one inside the window', () => {
    const doc = xml(prog('a', '20261004000000', null, 'Open') + prog('a', '20261004020000', '20261004030000', 'Next'));
    const r = parseXMLTV(doc, { from: Date.UTC(2026, 9, 4, 1), to: Date.UTC(2026, 9, 5) });
    expect(r.programs.find((p) => p.title === 'Open')!.end).toBe(Date.UTC(2026, 9, 4, 2));
  });

  it('never name-matches channels whose names normalize to empty', () => {
    const channels = [ch('p1', '***'), ch('p2', 'ESPN')];
    const doc = xml(
      prog('x.empty', '20261004000000', '20261004010000', 'Mystery') + prog('x.espn', '20261004000000', '20261004010000', 'SportsCenter'),
      '<channel id="x.empty"><display-name>!!!</display-name></channel><channel id="x.espn"><display-name>ESPN</display-name></channel>',
    );
    const r = mapXmltvPrograms(doc, channels);
    expect(r.programs.map((p) => p.channelId)).toEqual(['p2']);
    expect(r.unmatched.map((u) => u.id)).toEqual(['x.empty']);
  });
});
