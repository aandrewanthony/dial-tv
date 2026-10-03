import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAttributes, parseM3U } from '../../src/lib/m3u';
import { parseXMLTV, parseXmltvDate } from '../../src/lib/xmltv';
import { mapXmltvPrograms } from '../../src/providers/remote';
import { redactUrl, safeUrl } from '../../src/lib/url';

const fixture = (f: string) => readFileSync(resolve('tests/fixtures', f), 'utf8');

describe('parseM3U', () => {
  it('parses attributes, groups, logos and header EPG url', () => {
    const r = parseM3U(fixture('sports.m3u'), 'src');
    expect(r.epgUrl).toBe('http://localhost:1420/__test/guide.xml');
    expect(r.channels.map((c) => c.name)).toEqual(['US| ESPN HD', 'US| ESPN 2', 'FOX (WNYW) New York', 'CBS East HD', 'NFL Network']);
    expect(r.channels[0]).toMatchObject({ tvgId: 'espn.us', group: 'US| Sports', sourceId: 'src', mark: 'EH' });
    expect(r.channels[0].logo).toBeUndefined(); // empty tvg-logo
  });

  it('skips malformed entries and unsafe protocols', () => {
    const r = parseM3U(fixture('sports.m3u'));
    expect(r.skipped.map((s) => s.reason)).toEqual(['EXTINF without URL', 'Invalid or unsupported URL']);
    expect(r.channels.every((c) => c.url.startsWith('http'))).toBe(true);
  });

  it('handles commas inside quoted attributes, tvg-chno, Kodi pipe headers and VLC opts', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-chno="7" group-title="News, Local" tvg-logo="https://x/y.png",WABC, New York',
      '#EXTVLCOPT:http-referrer=https://ref.example/',
      'https://cdn.example/abc.m3u8|User-Agent=Dial%2F1.0',
      '#EXTINF:-1,Dup',
      'https://cdn.example/1.ts',
      '#EXTINF:-1,Dup',
      'https://cdn.example/2.ts',
    ].join('\r\n');
    const r = parseM3U(text, 's');
    expect(r.channels[0]).toMatchObject({ number: 7, name: 'WABC, New York', group: 'News, Local', logo: 'https://x/y.png', userAgent: 'Dial/1.0', referrer: 'https://ref.example/' });
    expect(r.channels[0].url).toBe('https://cdn.example/abc.m3u8');
    expect(new Set(r.channels.map((c) => c.id)).size).toBe(3); // duplicate names get unique ids
  });

  it('handles BOM, #EXTGRP and URLs without EXTINF', () => {
    const r = parseM3U('﻿#EXTM3U\nhttps://orphan.example/x.m3u8\n#EXTINF:-1,A\n#EXTGRP:Kids\nhttps://a.example/a.m3u8');
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0].group).toBe('Kids');
    expect(r.skipped[0].reason).toBe('URL without EXTINF');
  });

  it('parseAttributes supports single quotes and bare values', () => {
    expect(parseAttributes(`tvg-id='a' tvg-chno=5 group-title="G"`)).toEqual({ 'tvg-id': 'a', 'tvg-chno': '5', 'group-title': 'G' });
  });
});

describe('XMLTV', () => {
  it('parses dates with offsets to UTC', () => {
    expect(parseXmltvDate('20261003120000 -0400')).toBe(Date.UTC(2026, 9, 3, 16, 0, 0));
    expect(parseXmltvDate('20261003120000 +0530')).toBe(Date.UTC(2026, 9, 3, 6, 30, 0));
    expect(parseXmltvDate('20261003120000')).toBe(Date.UTC(2026, 9, 3, 12, 0, 0));
    expect(parseXmltvDate('202610031200 +01:00')).toBe(Date.UTC(2026, 9, 3, 11, 0, 0));
    expect(parseXmltvDate('garbage')).toBeNull();
  });

  it('parses channels/programmes, flags sports + new, clamps missing stop to next start', () => {
    const r = parseXMLTV(fixture('guide.xml'));
    expect(r.channels.map((c) => c.id)).toEqual(['espn.us', 'cbs.us', 'unmapped.us']);
    const sc = r.programs.find((p) => p.title === 'SportsCenter')!;
    expect(sc.end).toBe(Date.UTC(2026, 9, 3, 23, 0)); // clamped to Postgame start (19:00 -0400)
    expect(r.programs.find((p) => p.title === 'College GameDay')).toMatchObject({ isSports: true, isNew: true });
    expect(r.programs.find((p) => p.title === 'SEC on CBS')!.isSports).toBe(true);
  });

  it('rejects malformed XML', () => {
    expect(() => parseXMLTV('<tv><channel></tv>')).toThrow(/not well-formed/);
  });

  it('maps programmes to playlist channels by tvg-id, name, and manual mapping', () => {
    const channels = parseM3U(fixture('sports.m3u'), 'src').channels;
    const r = mapXmltvPrograms(fixture('guide.xml'), channels);
    const espn = channels.find((c) => c.tvgId === 'espn.us')!;
    expect(r.programs.filter((p) => p.channelId === espn.id)).toHaveLength(4);
    expect(r.unmatched.map((u) => u.id)).toEqual(['unmapped.us']);
    const nfl = channels.find((c) => c.name === 'NFL Network')!;
    const manual = mapXmltvPrograms(fixture('guide.xml'), channels, { [nfl.id]: 'cbs.us' });
    expect(manual.programs.filter((p) => p.channelId === nfl.id)).toHaveLength(2);
  });
});

describe('url safety', () => {
  it('allows only http(s)', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl(' https://a.example/x ')).toBe('https://a.example/x');
  });
  it('redacts credentials in userinfo, query and Xtream paths', () => {
    expect(redactUrl('http://bob:hunter2@h.example/get.php?username=bob&password=hunter2&type=m3u')).toBe(
      'http://***@h.example/get.php?username=***&password=***&type=m3u',
    );
    expect(redactUrl('http://h.example/live/bob/hunter2/123.m3u8')).toBe('http://h.example/live/***/***/123.m3u8');
  });
});
