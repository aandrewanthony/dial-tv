// Renders build/icon.svg to the PNG/ICO assets electron-builder and the window need.
// Uses Playwright's Chromium (already a dev dependency) so no native image tools are required.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const svg = fs.readFileSync('build/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();

async function render(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

fs.writeFileSync('build/icon.png', await render(1024));
fs.writeFileSync('electron/icon.png', await render(512));

// ICO with embedded PNG images (supported since Windows Vista).
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const s of sizes) images.push(await render(s));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((s, i) => {
  const o = i * 16;
  dir.writeUInt8(s === 256 ? 0 : s, o); dir.writeUInt8(s === 256 ? 0 : s, o + 1);
  dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(images[i].length, o + 8); dir.writeUInt32LE(offset, o + 12);
  offset += images[i].length;
});
fs.writeFileSync('build/icon.ico', Buffer.concat([header, dir, ...images]));
await browser.close();
console.log('icons: build/icon.png, build/icon.ico, electron/icon.png');
