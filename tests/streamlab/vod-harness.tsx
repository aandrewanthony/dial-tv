// Mounts the real Player in movie mode for tests/streamlab/vod.mjs. Records onProgress / onEnded
// calls in window.__vod and exposes the player handle as window.__player.
import { createRoot } from 'react-dom/client';
import Player, { type PlayerHandle } from '../../src/player/Player';
import { useApp } from '../../src/store/app';
import '../../src/style.css';

const q = new URLSearchParams(location.search);
const rec = { progress: [] as [number, number][], ended: 0 };
const w = window as unknown as { __vod: typeof rec; __player: PlayerHandle | null };
w.__vod = rec;
const channel = { id: `vod:${q.get('u')}`, name: 'VOD lab', url: q.get('u') ?? '', group: 'Lab', number: 1 } as never;
// ?decoder=always: go straight to the built-in decoder (like a remembered channel).
if (q.get('decoder')) useApp.getState().update((st) => ({ settings: { ...st.settings, decoder: q.get('decoder') as 'auto' | 'always' | 'off' } }));
createRoot(document.getElementById('root')!).render(
  <div className="hero">
    <Player
      ref={(h) => { w.__player = h; }}
      channel={channel}
      vod={q.get('vod') !== '0'}
      startAt={q.get('startAt') ? +q.get('startAt')! : undefined}
      onProgress={(s, d) => rec.progress.push([s, d])}
      onEnded={() => { rec.ended++; }}
    />
  </div>,
);
