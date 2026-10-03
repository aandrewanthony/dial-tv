# Dial TV — IPTV Command Center
A functional base IPTV player for Web, Windows, and macOS. It is intended for streams/playlists the user is authorized to access.

## Included
- HLS playback via native Safari HLS or hls.js
- Three public demo/test HLS streams
- TV-style responsive UI
- Channel switching, favorites, search
- Cable-style EPG prototype
- Drag/drop personal scheduler with local persistence
- Sports hub with channel tune-in
- Local M3U import/parser
- Shared React/TypeScript codebase
- Tauri 2 desktop wrapper for Windows/macOS

## Web
`npm install` then `npm run dev`. Production: `npm run build`; deploy `dist/` to any static host. Remote HLS servers must permit browser playback/CORS.

## Windows/macOS
Install Rust and Tauri OS prerequisites, then `npm install` and `npm run tauri build`. Windows produces its supported installer bundles. macOS builds must run on macOS; distribution signing/notarization requires your Apple Developer credentials.

## Demo data
`src/data/demo.ts` contains synthetic EPG/sports listings and public HLS test streams. Replace through provider adapters in production.
