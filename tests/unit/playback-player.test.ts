import { describe, expect, it } from 'vitest';
import { channelHeaders, type StreamInfo } from '../../src/lib/net';
import { directPlayable, highBitDepth } from '../../src/player/Player';

const info = (p: Partial<StreamInfo>): StreamInfo => ({ video: null, audio: null, interlaced: false, resolution: null, ...p });

describe('player helpers', () => {
  it('builds sanitized playlist headers for the shell / decoder', () => {
    expect(channelHeaders({ userAgent: 'UA\r\n', referrer: 'https://r/', headers: { Origin: 'https://o', Cookie: 'a=b', 'Bad Name': 'x', Empty: ' ' } }))
      .toEqual({ Origin: 'https://o', Cookie: 'a=b', 'User-Agent': 'UA', Referer: 'https://r/' });
    expect(channelHeaders({})).toEqual({});
  });
  it('treats 10-bit / 4:2:2 H.264 as not directly playable', () => {
    expect(highBitDepth(info({ video: 'h264', pixFmt: 'yuv420p10le' }))).toBe(true);
    expect(highBitDepth(info({ video: 'h264', profile: 'High 4:2:2' }))).toBe(true);
    expect(directPlayable(info({ video: 'h264', audio: 'aac', pixFmt: 'yuv420p', profile: 'High' }))).toBe(true);
    expect(directPlayable(info({ video: 'h264', audio: 'aac', pixFmt: 'yuv420p10le', profile: 'High 10' }))).toBe(false);
    expect(directPlayable(info({ video: 'mpeg2video', audio: 'mp2' }))).toBe(false);
    expect(directPlayable(info({ audio: 'mp3' }))).toBe(true); // radio
  });
});
