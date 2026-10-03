// Runs Vite and the Electron shell together with hot reload.
import { spawn } from 'node:child_process';
const url = 'http://localhost:1420';
const vite = spawn('npx', ['vite'], { stdio: 'inherit', shell: true });
const wait = async () => { for (;;) { try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 300)); } } };
await wait();
const app = spawn('npx', ['electron', '.'], { stdio: 'inherit', shell: true, env: { ...process.env, DIAL_DEV_URL: url } });
app.on('exit', () => { vite.kill(); process.exit(0); });
