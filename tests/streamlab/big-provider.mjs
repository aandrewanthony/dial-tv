// Generates a realistic "big IPTV provider" playlist + XMLTV guide for performance and
// organization testing: thousands of channels with country prefixes, quality duplicates
// (HD/FHD/4K/backup), messy groups, VOD mixed in, and a multi-day guide.
//   node tests/streamlab/big-provider.mjs [channels=6000] [days=3]
// Writes tests/streamlab/media/big.m3u and big-epg.xml(.gz); server.mjs serves /big.m3u and /big-epg.xml.gz
import fs from 'node:fs';
import zlib from 'node:zlib';

const N = Number(process.argv[2] ?? 6000);
const DAYS = Number(process.argv[3] ?? 3);
const out = 'tests/streamlab/media';
fs.mkdirSync(out, { recursive: true });

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const countries = ['US', 'UK', 'CA', 'FR', 'DE', 'ES', 'IT', 'AR', 'IN', 'PT', 'NL', 'TR', 'PL', 'LATINO'];
const cats = {
  Sports: ['ESPN', 'ESPN 2', 'ESPNU', 'FS1', 'FS2', 'NFL Network', 'NBA TV', 'MLB Network', 'NHL Network', 'TNT', 'TBS', 'CBS Sports Network', 'Big Ten Network', 'SEC Network', 'ACC Network', 'Golf Channel', 'beIN Sports', 'Sky Sports Main Event', 'TSN 1', 'Sportsnet One', 'DAZN 1', 'Eurosport 1'],
  News: ['CNN', 'Fox News', 'MSNBC', 'CNBC', 'BBC News', 'Sky News', 'Bloomberg', 'Al Jazeera', 'CBC News', 'France 24'],
  Entertainment: ['AMC', 'FX', 'USA Network', 'Bravo', 'E!', 'Comedy Central', 'TLC', 'A&E', 'History', 'Discovery', 'National Geographic', 'HGTV', 'Food Network', 'Paramount Network'],
  Movies: ['HBO', 'HBO 2', 'Cinemax', 'Showtime', 'Starz', 'TCM', 'Sky Cinema Premiere', 'Hallmark Movies'],
  Kids: ['Cartoon Network', 'Nickelodeon', 'Disney Channel', 'Disney Junior', 'Boomerang', 'PBS Kids'],
  Locals: ['ABC', 'CBS', 'NBC', 'FOX', 'CW', 'PBS'],
};
const cities = ['New York', 'Los Angeles', 'Chicago', 'Boston', 'Philadelphia', 'Dallas', 'Atlanta', 'Miami', 'Seattle', 'Denver'];
const groupStyles = [(c, k) => `${c}| ${k.toUpperCase()}`, (c, k) => `${c} - ${k}`, (c, k) => `[${c}] ${k}`, (c, k) => `${c}: ${k}`];
const qual = ['', ' HD', ' FHD', ' 4K', ' HEVC', ' (Backup)', ' SD'];

const lines = ['#EXTM3U url-tvg="http://127.0.0.1:8787/big-epg.xml.gz"'];
const epgChannels = new Map();
let i = 0;
while (i < N) {
  const country = pick(countries);
  const cat = pick(Object.keys(cats));
  let base = pick(cats[cat]);
  if (cat === 'Locals') base = `${base} ${pick(cities)}`;
  const style = pick(groupStyles);
  const group = style(country, cat);
  const tvgId = `${base.replace(/[^A-Za-z0-9]+/g, '')}.${country.toLowerCase()}`;
  // Each logical channel appears 1-4 times in different qualities (the provider "duplicates" problem).
  const copies = 1 + Math.floor(rnd() * 4);
  for (let c = 0; c < copies && i < N; c++, i++) {
    const name = `${country}| ${base}${qual[c === 0 ? 0 : 1 + Math.floor(rnd() * (qual.length - 1))]}`;
    lines.push(`#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${name}" tvg-logo="" group-title="${group}",${name}`);
    lines.push(`http://127.0.0.1:8787/live/lab/h264-aac?ch=${i}`);
  }
  epgChannels.set(tvgId, base);
}
// Some VOD mixed in, like real providers.
for (let m = 0; m < 400; m++) {
  lines.push(`#EXTINF:-1 tvg-id="" tvg-logo="" group-title="VOD | Movies ${pick(['Action', 'Comedy', 'Drama'])}",Movie ${m} (${1990 + (m % 34)})`);
  lines.push(`http://127.0.0.1:8787/movie/u/p/${m}.mp4`);
}
fs.writeFileSync(`${out}/big.m3u`, lines.join('\n') + '\n');

// XMLTV: every logical channel, DAYS days of 30-60 min programmes, starting 12h ago.
const fmt = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`; };
const titles = ['SportsCenter', 'NFL Live', 'Evening News', 'Movie: The Long Night', 'Law & Order', 'Cartoon Hour', 'Live: College Football', 'Morning Show', 'Documentary', 'Talk Tonight'];
const start0 = Math.floor((Date.now() - 12 * 3600e3) / 1800e3) * 1800e3;
const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="dial-tv big-provider">\n'];
for (const [id, name] of epgChannels) parts.push(`  <channel id="${id}"><display-name>${name.replace(/&/g, '&amp;')}</display-name></channel>\n`);
let programmes = 0;
for (const id of epgChannels.keys()) {
  let t = start0;
  const end = start0 + DAYS * 86400e3;
  while (t < end) {
    const len = (rnd() < 0.5 ? 30 : 60) * 60e3;
    const title = pick(titles).replace(/&/g, '&amp;');
    parts.push(`  <programme start="${fmt(t)}" stop="${fmt(t + len)}" channel="${id}"><title>${title}</title><desc>Description of ${title}.</desc><category>${title.includes('Football') || title.includes('NFL') || title.includes('Sports') ? 'Sports' : 'General'}</category></programme>\n`);
    t += len;
    programmes++;
  }
}
parts.push('</tv>\n');
const xml = parts.join('');
fs.writeFileSync(`${out}/big-epg.xml`, xml);
fs.writeFileSync(`${out}/big-epg.xml.gz`, zlib.gzipSync(xml));
console.log(`big.m3u: ${i} live entries (${epgChannels.size} distinct channels) + 400 VOD; big-epg: ${programmes} programmes, ${(xml.length / 1e6).toFixed(1)} MB (${(fs.statSync(`${out}/big-epg.xml.gz`).size / 1e6).toFixed(1)} MB gz)`);
