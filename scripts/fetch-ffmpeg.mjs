// Puts the ffmpeg binaries the desktop builds bundle into vendor/ffmpeg/<platform>-<arch>/.
// Same binaries ffmpeg-static ships (release b6.0). Windows reuses the installed copy so the
// file is byte-identical to the one verified against Smart App Control.
//   node scripts/fetch-ffmpeg.mjs win32-x64 darwin-x64 darwin-arm64
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Same release tag the installed ffmpeg-static uses, so every platform ships the same ffmpeg build.
const TAG = require('ffmpeg-static/package.json')['ffmpeg-static']['binary-release-tag'];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [`${process.platform}-${process.arch}`];

for (const t of targets) {
  const exe = t.startsWith('win32') ? 'ffmpeg.exe' : 'ffmpeg';
  const dir = path.join('vendor', 'ffmpeg', t);
  const dest = path.join(dir, exe);
  fs.mkdirSync(dir, { recursive: true });
  const local = require('ffmpeg-static');
  if (t === `${process.platform}-${process.arch}` && fs.existsSync(local)) {
    fs.copyFileSync(local, dest);
  } else {
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${TAG}/ffmpeg-${t}.gz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
    fs.writeFileSync(dest, zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
  }
  fs.chmodSync(dest, 0o755);
  console.log(`ffmpeg ${t}: ${dest} (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
}
