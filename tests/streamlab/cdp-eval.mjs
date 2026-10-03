// Debug helper: evaluate JS in a running Dial TV (CDP) and optionally screenshot. node tests/streamlab/cdp-eval.mjs <port> "<js>" [shot.png]
import { chromium } from '@playwright/test';
const b = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`);
const page = b.contexts()[0].pages()[0];
const r = await page.evaluate(process.argv[3]);
console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
if (process.argv[4]) await page.screenshot({ path: process.argv[4] });
await b.close();
