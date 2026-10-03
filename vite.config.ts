import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the same build runs from file:// inside the desktop app.
  base: './',
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  // hls.js is lazy-loaded and legitimately ~600 kB.
  build: { chunkSizeWarningLimit: 700, target: 'es2020' },
});
