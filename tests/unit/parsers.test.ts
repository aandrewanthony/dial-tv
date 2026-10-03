import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAttributes, parseHeaderPairs, parseM3U, safeDecode } from '../../src/lib/m3u';
import { parseXMLTV, parseXmltvDate } from '../../src/lib/xmltv';
import { mapXmltvPrograms } from '../../src/providers/remote';
import { cleanHeaderValue, redactUrl, safeStreamUrl, safeUrl, splitUserinfo } from '../../src/lib/url';

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

  it('accepts the streaming protocols VLC plays and still rejects unsafe ones', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:-1,Multicast', 'udp://@239.1.1.1:1234',
      '#EXTINF:-1,RTMP', 'rtmp://host.example/app/key',
      '#EXTINF:-1,RTSP', 'rtsp://cam.example:554/stream1',
      '#EXTINF:-1,RTP', 'rtp://239.0.0.1:5000',
      '#EXTINF:-1,MMS', 'mms://media.example/live',
      '#EXTINF:-1,MMSH', 'mmsh://media.example/live',
      '#EXTINF:-1,SRT', 'srt://srt.example:9000',
      '#EXTINF:-1,RTMPS', 'rtmps://host.example/app/key',
      '#EXTINF:-1,JS', 'javascript:alert(1)',
      '#EXTINF:-1,File', 'file:///etc/passwd',
      '#EXTINF:-1,Data', 'data:video/mp4;base64,AAAA',
      '#EXTINF:-1,FTP', 'ftp://h.example/x.ts',
      '#EXTINF:-1,Concat', 'concat:a.ts|b.ts',
    ].join('\n');
    const r = parseM3U(text, 's');
    expect(r.channels.map((c) => c.url)).toEqual([
      'udp://@239.1.1.1:1234', 'rtmp://host.example/app/key', 'rtsp://cam.example:554/stream1', 'rtp://239.0.0.1:5000',
      'mms://media.example/live', 'mmsh://media.example/live', 'srt://srt.example:9000', 'rtmps://host.example/app/key',
    ]);
    expect(r.skipped).toHaveLength(5);
  });

  it('reads headers from EXTINF attributes, #EXTVLCOPT, #EXTHTTP, #KODIPROP and pipe options', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:-1 http-user-agent="AttrUA/1" http-referrer="https://attr.example/",A',
      'https://a.example/a.m3u8',
      '#EXTINF:-1 referer="https://r.example/",B',
      'https://b.example/b.m3u8',
      '#EXTINF:-1,C',
      '#EXTVLCOPT:http-origin=https://o.example',
      '#EXTVLCOPT:http-cookie=sid=abc=def; x=1',
      '#EXTVLCOPT:http-user-agent=VlcOptUA',
      'https://c.example/c.m3u8',
      '#EXTINF:-1,D',
      '#EXTHTTP:{"cookie":"k=v","User-Agent":"JsonUA","Referer":"https://j.example/"}',
      'https://d.example/d.m3u8',
      '#EXTINF:-1,E',
      '#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=Kodi%2F20&Origin=https%3A%2F%2Fk.example',
      'https://e.example/e.mpd',
      '#EXTINF:-1 user-agent="Weak",F',
      'https://f.example/f.ts|User-Agent=Pipe%2F1&Origin=https://p.example&Cookie=t=a=b&Referer=%E0%A4%A',
    ].join('\n');
    const [a, b, c, d, e, f] = parseM3U(text, 's').channels;
    expect(a).toMatchObject({ userAgent: 'AttrUA/1', referrer: 'https://attr.example/' });
    expect(b).toMatchObject({ referrer: 'https://r.example/' });
    expect(c).toMatchObject({ userAgent: 'VlcOptUA', headers: { Origin: 'https://o.example', Cookie: 'sid=abc=def; x=1' } });
    expect(d).toMatchObject({ userAgent: 'JsonUA', referrer: 'https://j.example/', headers: { cookie: 'k=v' } });
    expect(e).toMatchObject({ userAgent: 'Kodi/20', headers: { Origin: 'https://k.example' } });
    expect(f).toMatchObject({ url: 'https://f.example/f.ts', userAgent: 'Pipe/1', referrer: '%E0%A4%A', headers: { Origin: 'https://p.example', Cookie: 't=a=b' } });
    expect(a.headers).toBeUndefined();
  });

  it('never lets CR/LF from a playlist into header values, and survives malformed options', () => {
    const r = parseM3U('#EXTM3U\n#EXTINF:-1,X\n#EXTHTTP:{not json\nhttps://x.example/x.ts|User-Agent=a%0D%0AX-Evil:%201&=novalue&noeq\n');
    expect(r.channels[0].userAgent).toBe('a X-Evil: 1');
    expect(r.channels[0].headers).toBeUndefined();
  });

  it('pipe/header helpers split on the first "=" and decode safely', () => {
    expect(parseHeaderPairs('A=1=2&B=%ZZ&=x&C')).toEqual([['A', '1=2'], ['B', '%ZZ']]);
    expect(safeDecode('%E0%A4%A')).toBe('%E0%A4%A');
    expect(safeDecode('Dial%2F1.0')).toBe('Dial/1.0');
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
  it('stream URLs allow VLC protocols but not local/script ones', () => {
    expect(safeStreamUrl('udp://@239.1.1.1:1234')).toBe('udp://@239.1.1.1:1234');
    expect(safeStreamUrl('rtsp://u:p@cam.example/live')).toBe('rtsp://u:p@cam.example/live');
    expect(safeStreamUrl('HTTPS://A.example/x')).toBe('https://a.example/x');
    for (const bad of ['javascript:alert(1)', 'file:///C:/x.ts', 'data:text/html,x', 'blob:https://a/x', 'ftp://a/x', 'rtmp:nohost', 'udp://', 'rtmp://a b/c', 'chrome://settings']) {
      expect(safeStreamUrl(bad)).toBeNull();
    }
    expect(safeUrl('rtmp://host/app')).toBeNull(); // playlist/EPG downloads stay http(s)-only
  });
  it('splits user:pass@ into a clean URL plus Basic auth', () => {
    expect(splitUserinfo('http://bob:p%40ss@h.example/live.ts')).toEqual({ url: 'http://h.example/live.ts', authorization: `Basic ${btoa('bob:p@ss')}` });
    expect(splitUserinfo('http://h.example/x')).toEqual({ url: 'http://h.example/x' });
    expect(cleanHeaderValue('a\r\nb\0c')).toBe('a b c');
  });
  it('redacts credentials in userinfo, query and Xtream paths', () => {
    expect(redactUrl('http://bob:hunter2@h.example/get.php?username=bob&password=hunter2&type=m3u')).toBe(
      'http://***@h.example/get.php?username=***&password=***&type=m3u',
    );
    expect(redactUrl('http://h.example/live/bob/hunter2/123.m3u8')).toBe('http://h.example/live/***/***/123.m3u8');
  });
});
