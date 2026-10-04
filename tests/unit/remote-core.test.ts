import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('../../electron/remoteCore.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sanitizeState } = require('../../electron/remoteMain.cjs');

/** Deterministic digits for codes: cycles through `seq`. */
const digits = (seq: string) => { let i = 0; return () => Number(seq[i++ % seq.length]); };

describe('remote pairing codes and tokens', () => {
  it('makes 6-digit codes, keeping leading zeros', () => {
    expect(core.newPairingCode(digits('007123'))).toBe('007123');
    for (let i = 0; i < 50; i++) expect(core.newPairingCode()).toMatch(/^\d{6}$/);
  });
  it('makes long random tokens and stores only their hash', () => {
    const a = core.newToken();
    const b = core.newToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(core.hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(core.safeEqual('abc', 'abc')).toBe(true);
    expect(core.safeEqual('abc', 'abd')).toBe(false);
    expect(core.safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('remote rate limiter', () => {
  it('locks an address after 5 wrong tries in a minute, for 5 minutes', () => {
    const rl = core.createRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) expect(rl.fail('a', t0 + i).locked).toBe(false);
    expect(rl.check('a', t0 + 10).ok).toBe(true);
    expect(rl.fail('a', t0 + 10)).toMatchObject({ locked: true });
    expect(rl.check('a', t0 + 11)).toMatchObject({ ok: false });
    expect(rl.check('b', t0 + 11).ok).toBe(true); // other addresses unaffected
    expect(rl.check('a', t0 + 10 + core.LOCK_MS - 1).ok).toBe(false);
    expect(rl.check('a', t0 + 10 + core.LOCK_MS).ok).toBe(true);
  });
  it('forgets failures older than the window', () => {
    const rl = core.createRateLimiter();
    for (let i = 0; i < 4; i++) rl.fail('a', i);
    expect(rl.fail('a', core.TRY_WINDOW_MS + 10)).toEqual({ locked: false, left: 4 });
  });
});

describe('remote pairing', () => {
  const setup = (devices: unknown[] = []) => {
    let t = 5_000_000;
    const onChange = vi.fn();
    let i = 0;
    const p = core.createPairing({ devices, randInt: () => i++ % 10, now: () => t, onChange });
    return { p, onChange, tick: (ms: number) => { t += ms; } };
  };

  it('pairs with the right code, returns a token, then rotates the code', () => {
    const { p, onChange } = setup();
    expect(p.code).toBe('012345');
    const r = p.pair('012 345', '10.0.0.5', 'Andrew’s <iPhone>');
    expect(r.ok).toBe(true);
    expect(r.device.name).toBe('Andrew’s iPhone');
    expect(p.verify(r.token)?.id).toBe(r.device.id);
    expect(p.verify(r.token + 'x')).toBeNull();
    expect(p.verify('short')).toBeNull();
    expect(p.verify(undefined)).toBeNull();
    // Stored list has the hash, never the token.
    const stored = p.stored();
    expect(JSON.stringify(stored)).not.toContain(r.token);
    expect(stored[0].tokenHash).toBe(core.hashToken(r.token));
    expect(onChange).toHaveBeenCalled();
    // The code is single-use: replaying it fails.
    expect(p.code).toBe('678901');
    expect(p.pair('012345', '10.0.0.6', 'x')).toMatchObject({ ok: false, error: 'bad' });
  });

  it('rejects wrong codes and locks the address after 5 tries', () => {
    const { p } = setup();
    for (let i = 0; i < 4; i++) expect(p.pair('000000', '10.0.0.9')).toMatchObject({ ok: false, error: 'bad', left: 4 - i });
    expect(p.pair('000000', '10.0.0.9')).toMatchObject({ ok: false, error: 'locked' });
    // Even the right code is refused while locked.
    expect(p.pair(p.code, '10.0.0.9')).toMatchObject({ ok: false, error: 'locked' });
    expect(p.pair(p.code, '10.0.0.10').ok).toBe(true);
  });

  it('replaces the code after 10 wrong tries from any addresses', () => {
    let n = 0;
    const p = core.createPairing({ randInt: () => (n++ < 6 ? 1 : 2) });
    expect(p.code).toBe('111111');
    for (let i = 0; i < 9; i++) p.pair('999999', `10.0.1.${i}`);
    expect(p.code).toBe('111111');
    p.pair('999999', '10.0.1.99');
    expect(p.code).toBe('222222');
  });

  it('loads stored devices, revokes, and caps the list', () => {
    const { p } = setup([{ id: 'a1', name: 'Old', tokenHash: core.hashToken('t'.repeat(43)), created: 1, lastSeen: 1 }, { bogus: true }]);
    expect(p.devices().map((d: { id: string }) => d.id)).toEqual(['a1']);
    expect(p.verify('t'.repeat(43))?.id).toBe('a1');
    expect(p.revoke('a1')).toBe(true);
    expect(p.verify('t'.repeat(43))).toBeNull();
    expect(p.revoke('a1')).toBe(false);
    for (let i = 0; i < core.MAX_DEVICES + 2; i++) expect(p.pair(p.code, `10.0.2.${i}`).ok).toBe(true);
    expect(p.devices()).toHaveLength(core.MAX_DEVICES);
  });
});

describe('remote commands', () => {
  it('accepts only known, well-formed commands', () => {
    for (const t of ['chup', 'chdown', 'play', 'mute', 'volup', 'voldown', 'last', 'guide']) expect(core.validateCommand({ type: t, extra: 1 })).toEqual({ type: t });
    expect(core.validateCommand({ type: 'number', value: '205' })).toEqual({ type: 'number', value: '205' });
    expect(core.validateCommand({ type: 'number', value: '2a' })).toBeNull();
    expect(core.validateCommand({ type: 'number', value: '123456' })).toBeNull();
    expect(core.validateCommand({ type: 'tune', id: 'pl:1' })).toEqual({ type: 'tune', id: 'pl:1' });
    expect(core.validateCommand({ type: 'tune', id: 'x'.repeat(600) })).toBeNull();
    expect(core.validateCommand({ type: 'eval', code: '1' })).toBeNull();
    expect(core.validateCommand(null)).toBeNull();
    expect(core.validateCommand('chup')).toBeNull();
  });
  it('keeps only now-playing fields in pushed state', () => {
    const s = sanitizeState({ channel: { number: 5, name: 'ESPN', evil: 1 }, title: 'Game', favorites: [{ id: 'a', number: 1, name: 'A', url: 'http://secret' }, { nope: 1 }], url: 'http://user:pw@x' });
    expect(s).toEqual({ channel: { number: '5', name: 'ESPN' }, currentId: undefined, title: 'Game', time: undefined, next: undefined, guideOpen: false, favorites: [{ id: 'a', number: '1', name: 'A' }] });
    expect(JSON.stringify(s)).not.toContain('secret');
  });
});

describe('remote network helpers', () => {
  it('prefers private Wi-Fi/Ethernet addresses over virtual adapters', () => {
    const ifaces = {
      'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.48.1', internal: false }],
      Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      'Wi-Fi': [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.42', internal: false }],
      Odd: [{ family: 4, address: '169.254.3.3', internal: false }],
    };
    expect(core.lanAddresses(ifaces)).toEqual(['192.168.1.42', '172.20.48.1']);
  });
  it('allows IP-literal hosts only (no DNS rebinding)', () => {
    expect(core.hostAllowed('192.168.1.42:47800')).toBe(true);
    expect(core.hostAllowed('localhost:47800')).toBe(true);
    expect(core.hostAllowed('[::1]:47800')).toBe(true);
    expect(core.hostAllowed('evil.example:47800')).toBe(false);
    expect(core.hostAllowed(undefined)).toBe(false);
  });
});

describe('remote WebSocket framing', () => {
  it('computes the RFC 6455 accept key', () => {
    expect(core.acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
  it('round-trips masked client frames, in pieces and fragmented', () => {
    const parser = core.createFrameParser();
    const f = Buffer.concat([core.encodeClientFrame('{"a":1}'), core.encodeClientFrame('x'.repeat(300))]);
    const out = [...parser.push(f.subarray(0, 5)), ...parser.push(f.subarray(5, 200)), ...parser.push(f.subarray(200))];
    expect(out.map((m: { data: Buffer }) => m.data.toString())).toEqual(['{"a":1}', 'x'.repeat(300)]);
    // Fragmented: first frame without FIN, then a continuation.
    const a = core.encodeClientFrame('hel');
    a[0] = 0x01; // text, no FIN
    const b = core.encodeClientFrame('lo', 0); // continuation + FIN
    expect(parser.push(Buffer.concat([a, b])).map((m: { data: Buffer }) => m.data.toString())).toEqual(['hello']);
  });
  it('rejects unmasked and oversized frames', () => {
    expect(() => core.createFrameParser().push(core.encodeFrame('hi'))).toThrow(/unmasked/);
    expect(() => core.createFrameParser(100).push(core.encodeClientFrame('x'.repeat(200)))).toThrow(/too large/);
  });
  it('encodes server frames with the right length header', () => {
    expect([...core.encodeFrame('hi').subarray(0, 2)]).toEqual([0x81, 2]);
    const mid = core.encodeFrame('x'.repeat(300));
    expect(mid[1]).toBe(126);
    expect(mid.readUInt16BE(2)).toBe(300);
    expect(core.encodeFrame('x'.repeat(70000))[1]).toBe(127);
  });
});
