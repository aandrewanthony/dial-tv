import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import lightTheme from './scripts/light-theme.mjs';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the same build runs from file:// inside the desktop app.
  base: './',
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  // The light theme is generated from the dark stylesheet (scripts/light-theme.mjs).
  css: { postcss: { plugins: [lightTheme()] } },
  // hls.js is lazy-loaded and legitimately ~600 kB.
  build: { chunkSizeWarningLimit: 700, target: 'es2020' },
});
