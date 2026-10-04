import { describe, expect, it } from 'vitest';
import { codewords, encodeQr, formatBits, qrPath, rsDivisor, rsRemainder, type QrCode } from '../../src/lib/qr';

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Read the data codewords back out of a symbol (unmask + zigzag), like a scanner would. */
function readBack(q: QrCode, count: number): number[] {
  const bits: number[] = [];
  const m = MASKS[q.mask];
  for (let right = q.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < q.size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? q.size - 1 - vert : vert;
      if (!q.isFunction[y][x]) bits.push(Number(q.modules[y][x] !== m(x, y)));
    }
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

describe('QR encoder', () => {
  it('Reed–Solomon matches the 1-M "HELLO WORLD" reference codewords', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('format information matches the level-M table', () => {
    const table = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
    table.forEach((bits, mask) => expect(formatBits(mask).toString(2).padStart(15, '0')).toBe(bits));
  });

  it('draws finder patterns, timing, dark module, and the data read back intact', () => {
    for (const text of ['http://192.168.1.42:47800/', 'http://10.0.0.5:47801/', 'x'.repeat(120)]) {
      const q = encodeQr(text);
      expect(q.size).toBe(q.version * 4 + 17);
      // Finder: 7x7 ring with a 3x3 centre, top-left/top-right/bottom-left.
      for (const [ox, oy] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]]) {
        for (let i = 0; i < 7; i++) {
          expect(q.modules[oy][ox + i]).toBe(true);
          expect(q.modules[oy + 6][ox + i]).toBe(true);
        }
        expect(q.modules[oy + 1][ox + 1]).toBe(false);
        expect(q.modules[oy + 3][ox + 3]).toBe(true);
      }
      for (let i = 8; i < q.size - 8; i++) expect(q.modules[6][i]).toBe(i % 2 === 0);
      expect(q.modules[q.size - 8][8]).toBe(true);
      // Both copies of the format bits carry the chosen mask.
      const f = formatBits(q.mask);
      const bit = (i: number) => ((f >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) expect(q.modules[i][8]).toBe(bit(i));
      for (let i = 0; i < 8; i++) expect(q.modules[8][q.size - 1 - i]).toBe(bit(i));
      const cw = codewords(Array.from(new TextEncoder().encode(text)), q.version);
      expect(readBack(q, cw.length)).toEqual(cw);
    }
  });

  it('picks the smallest version and rejects text that is too long', () => {
    expect(encodeQr('http://192.168.1.42:47800/').version).toBe(2);
    expect(encodeQr('x'.repeat(120)).version).toBe(7); // has version information blocks
    expect(() => encodeQr('x'.repeat(400))).toThrow();
    expect(qrPath(encodeQr('hi'))).toMatch(/^M4 4h1v1h-1z/);
  });
});
