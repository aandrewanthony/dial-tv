import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { sportOfLeague, sportOfProgram, sportsOfName, SPORTS } from '../../src/lib/sportsOf';
import { jobForNow, jobForProgram, recordingFor, recordingOn, type Recording } from '../../src/lib/dvr';
// @ts-expect-error plain JS build script
import { lightColor } from '../../scripts/light-theme.mjs';

const require = createRequire(import.meta.url);
const dvr = require('../../electron/dvr.cjs');

describe('sports by channel name', () => {
  it.each([
    ['NFL Network', 'US| SPORTS', 'US', ['football']],
    ['NBA TV', '', 'US', ['basketball']],
    ['MLB Network', '', 'US', ['baseball']],
    ['NHL Network', '', 'CA', ['hockey']],
    ['beIN Sports', '', 'US', ['soccer']],
    ['SEC Network', '', 'US', ['college']],
    ['Golf Channel', '', 'US', ['golf']],
    ['Tennis Channel', '', 'US', ['tennis']],
    ['UFC Fight Pass', '', 'US', ['fighting']],
    ['WWE Network', '', 'US', ['wrestling']],
    ['NASCAR Channel', '', 'US', ['motor']],
    ['TVG Horse Racing', '', 'US', ['horse']],
    ['Willow Cricket', '', 'US', ['cricket']],
    ['ESPN', 'US| SPORTS', 'US', []],
  ])('%s → %j', (name, group, country, want) => {
    expect(sportsOfName(name, group, country)).toEqual(want);
  });

  it('plain "Football" is soccer outside the US and Canada', () => {
    expect(sportsOfName('Sky Sports Football', '', 'UK')).toEqual(['soccer']);
    expect(sportsOfName('Football Extra', '', 'US')).toEqual(['football']);
  });

  it('lists every sport once', () => {
    expect(new Set(SPORTS.map((s) => s.key)).size).toBe(SPORTS.length);
  });
});

describe('sport of what is on', () => {
  it.each([
    ['NFL Football', 'Sports', 'football'],
    ['College Football', 'Sports', 'football'],
    ['NBA Basketball', 'Sports event', 'basketball'],
    ['Premier League: Arsenal v Spurs', 'Sports', 'soccer'],
    ['UFC 310', 'Sports', 'fighting'],
    ['Formula 1 Grand Prix', 'Sports', 'motor'],
    ['SportsCenter', 'Sports', undefined],
  ])('%s → %s', (title, cat, want) => {
    expect(sportOfProgram(title, cat)).toBe(want);
  });

  it('maps leagues', () => {
    expect(sportOfLeague('ncaaf')).toBe('football');
    expect(sportOfLeague('wnba')).toBe('basketball');
    expect(sportOfLeague('epl')).toBe('soccer');
  });
});

describe('light theme colours', () => {
  it('turns dark surfaces light and light text dark', () => {
    const lum = (h: string) => parseInt(h.slice(1, 3), 16);
    expect(lum(lightColor('#080a0f'))).toBeGreaterThan(240);
    expect(lum(lightColor('#f4f5f7'))).toBeLessThan(40);
  });
  it('keeps accent, black/white and video scrims', () => {
    expect(lightColor('#ff4d4d')).toBe('#ff4d4d');
    expect(lightColor('#000')).toBe('#000');
    expect(lightColor('#fff')).toBe('#fff');
    expect(lightColor('#000a')).toBe('#000a');
  });
  it('turns faint white hairlines into faint black', () => {
    expect(lightColor('#ffffff1f')).toMatch(/^#000000/);
  });
});

describe('DVR', () => {
  const now = Date.now();
  it('accepts a normal request and strips odd headers', () => {
    const j = dvr.validateJob({ url: 'http://p.example/live/1.ts', start: now, end: now + 3600_000, title: 'Game', headers: { 'User-Agent': 'x\r\nEvil: 1', 'bad header': 'y' } });
    expect(j.title).toBe('Game');
    expect(j.headers).toEqual({ 'User-Agent': 'x Evil: 1' });
  });
  it.each([
    [{ url: 'file:///C:/Windows/win.ini', start: now, end: now + 60_000 }],
    [{ url: 'http://x/y', start: now, end: now - 1 }],
    [{ url: 'http://x/y', start: now - 7200_000, end: now - 3600_000 }],
    [{ url: 'http://x/y', start: now, end: now + 9 * 3600_000 }],
  ])('rejects %j', (raw) => {
    expect(typeof dvr.validateJob(raw)).toBe('string');
  });
  it('record args copy streams into MPEG-TS with a time limit', () => {
    const a: string[] = dvr.recordArgs(() => ['-i', 'u'], 'u', {}, 90.4, 'out.ts');
    expect(a).toEqual(expect.arrayContaining(['-c', 'copy', '-t', '90', '-f', 'mpegts', 'out.ts']));
  });
  it('safe file names', () => {
    expect(dvr.slug('NFL: Bears @ Packers / "Week 5"?')).toBe('NFL Bears @ Packers Week 5');
  });

  const ch = { id: 'c1', number: 1, name: 'ESPN', group: '', mark: 'E', url: 'http://p/1.ts', sourceId: 's' };
  const settings = { folder: '', maxConcurrent: 2, padBefore: 1, padAfter: 3 };
  const prog = { id: 'p1', channelId: 'c1', title: 'Game', start: now + 3600_000, end: now + 7200_000, category: 'Sports' };
  it('pads guide recordings and finds them again', () => {
    const j = jobForProgram(ch, prog, settings);
    expect(j.start).toBe(prog.start - 60_000);
    expect(j.end).toBe(prog.end + 180_000);
    const rec: Recording = { id: 'r', channelId: 'c1', channelName: 'ESPN', title: 'Game', programId: 'p1', start: j.start, end: j.end, status: 'scheduled', createdAt: now };
    expect(recordingFor([rec], 'c1', prog)).toBe(rec);
    expect(recordingOn([rec], 'c1', now)).toBeUndefined();
  });
  it('record now runs to the end of the current show, or an hour', () => {
    const cur = { ...prog, start: now - 600_000, end: now + 1200_000 };
    expect(jobForNow(ch, cur, settings).end).toBe(cur.end + 180_000);
    expect(jobForNow(ch, undefined, settings).end - Date.now()).toBeGreaterThan(59 * 60_000);
  });
});
