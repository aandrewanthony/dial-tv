import type { Channel, Program } from '../types';
import type { EpgProvider, PlaylistProvider } from './types';
import { hashString, mulberry32 } from '../lib/seed';
import { startOfDay, HOUR, MIN } from '../lib/scheduler';

/** Public, freely licensed HLS test streams. */
export const DEMO_CHANNELS: Channel[] = [
  { id: 'demo:bbb', number: 101, name: 'Big Buck Bunny', group: 'Demo', mark: 'BB', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', sourceId: 'demo' },
  { id: 'demo:tears', number: 102, name: 'Tears of Steel', group: 'Movies', mark: 'TS', url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', sourceId: 'demo' },
  { id: 'demo:apple', number: 103, name: 'Apple Demo', group: 'Demo', mark: 'AD', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8', sourceId: 'demo' },
  { id: 'demo:sintel', number: 104, name: 'Sintel', group: 'Movies', mark: 'SI', url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8', sourceId: 'demo' },
  { id: 'demo:mux', number: 105, name: 'Mux Test Pattern', group: 'Demo', mark: 'MX', url: 'https://test-streams.mux.dev/test_001/stream.m3u8', sourceId: 'demo' },
];

export const demoPlaylist: PlaylistProvider = {
  id: 'demo',
  async load() {
    return { channels: DEMO_CHANNELS, skipped: 0 };
  },
};

const TITLES: Record<string, [string, string][]> = {
  Demo: [['Morning Mix', 'Entertainment'], ['Open Cinema', 'Movie'], ['Indie Showcase', 'Arts'], ['Tech Today', 'News'], ['Signal Check', 'Technology'], ['The Pregame', 'Sports'], ['Late Desk', 'Talk']],
  Movies: [['Animation Hour', 'Movie'], ['Behind the Frames', 'Documentary'], ['Director’s Cut', 'Movie'], ['Short Film Block', 'Arts'], ['Matinee', 'Movie']],
};
const SLOT_LENGTHS = [30, 30, 60, 60, 60, 90, 120];

/**
 * Deterministic EPG fixture: same seed + same calendar day ⇒ identical guide,
 * independent of the time of day the app was opened.
 */
export function generateFixtureGuide(channels: Channel[], from: number, days: number, seed = 42): Program[] {
  const out: Program[] = [];
  const day0 = startOfDay(from);
  for (const ch of channels) {
    const pool = TITLES[ch.group] ?? TITLES.Demo;
    for (let d = 0; d < days; d++) {
      const dayStart = startOfDay(day0 + d * 24 * HOUR + 2 * HOUR);
      const rnd = mulberry32(hashString(`${ch.id}|${new Date(dayStart).toDateString()}|${seed}`));
      let t = dayStart;
      while (t < dayStart + 24 * HOUR) {
        const len = SLOT_LENGTHS[Math.floor(rnd() * SLOT_LENGTHS.length)] * MIN;
        const [title, category] = pool[Math.floor(rnd() * pool.length)];
        const end = Math.min(t + len, dayStart + 24 * HOUR);
        out.push({
          id: `fx:${ch.id}:${t}`,
          channelId: ch.id,
          title,
          subtitle: rnd() > 0.5 ? `Episode ${1 + Math.floor(rnd() * 40)}` : undefined,
          description: `${title} on ${ch.name}. Synthetic demo listing generated from a fixed seed.`,
          start: t,
          end,
          category,
          isSports: category === 'Sports',
          isNew: rnd() > 0.8,
        });
        t = end;
      }
    }
  }
  return out;
}

export const demoEpg: EpgProvider = {
  id: 'demo',
  async load(channels) {
    return generateFixtureGuide(channels.filter((c) => c.sourceId === 'demo'), Date.now() - 24 * HOUR, 4);
  },
};
