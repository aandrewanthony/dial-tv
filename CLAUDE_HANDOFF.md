# CLAUDE HANDOFF — Dial TV

## Mission
Take this functioning V0.1 base and turn it into a production-grade personal TV command center for Web, Windows and macOS. Preserve a shared React/TypeScript UI. Do not add piracy-oriented discovery, DRM circumvention, credential bypass, or unauthorized restreaming.

## Current architecture
- React + TypeScript + Vite frontend.
- HLS playback: `src/components/Player.tsx` (hls.js with native-HLS fallback).
- Demo channels/programs/sports: `src/data/demo.ts`.
- Basic M3U parser: `src/lib/m3u.ts`.
- UI and DnD scheduler: `src/main.tsx`.
- Tauri 2 desktop shell: `src-tauri/`.
- LocalStorage persists schedule.

## Immediate engineering backlog (P0)
1. Refactor `main.tsx` into route/page/components and state stores.
2. Add robust M3U parser: tvg-id/name/logo, group-title, headers/options, malformed-entry handling.
3. Add XMLTV parser + channel mapping UI. Normalize all schedule dates/timezones.
4. Add provider interfaces: `PlaylistProvider`, `EpgProvider`, `SportsProvider` and mock implementations.
5. Replace synthetic time-relative demo guide with deterministic seeded fixture generation.
6. Scheduler: timeline/calendar views, draggable/resizable blocks, collision detection, overlap/conflict warnings, edit modal, notes, reminders, recurring team/show rules.
7. Guide: virtualized rows, true time-axis sizing, 30/60/120 min zoom, current-time line, date picker, Now button, program details drawer.
8. Player: loading/error/retry states, quality/audio/subtitle tracks, keyboard shortcuts, PiP, theater mode, last-channel resume, next/previous channel, stream diagnostics.
9. Persistence: IndexedDB on web and durable Tauri store/SQLite on desktop; migration/version layer.
10. Tests: parser fixtures, scheduler collision tests, component smoke tests and Playwright flows.

## Product backlog (P1)
- Favorites and custom channel groups.
- Hide/reorder channels by drag/drop.
- Unified global search for channel/program/team/league.
- Sports: API-backed schedule adapters, league/team favorites, live/upcoming/final state, venue/score metadata when licensed source supplies it, channel mapping.
- “Tonight” dashboard: selected live events + scheduled programs in chronological order.
- Multiview: 2x2 streams (subject to machine/browser limits).
- Mini player / always-on-top desktop window.
- Desktop native file picker and protocol handler.
- Import/export settings bundle.
- Theme/branding settings and compact/dense guide modes.
- Multiple playlists/accounts with per-source enable/disable.
- Parental controls and channel locks.
- Notifications for scheduled programs on desktop; optional browser notifications on web.

## Strong feature suggestions
### Smart Sports Mapper
When sports API event metadata says a game is on a named network, resolve that network against playlist channels using normalized aliases. Show confidence and let user correct mapping. Remember corrections locally.

### Personal Linear Channel
Allow the user to drag VOD/local media/program links into a timeline and create a personal pseudo-channel. Do not restream copyrighted media; playback stays local/direct from authorized sources.

### Game Day Mode
A dashboard of favorite-team events, start countdowns, mapped channels, and one-click tune. Optional multiview when games overlap.

### Schedule Rules
Examples: “Add every Knicks game,” “add new episodes of X,” or “reserve 7–10 PM for favorites.” Rules create schedule entries; they do not record content unless a lawful recording backend is later configured.

### Remote Control Mode
A phone-sized web route can control a desktop instance over an authenticated local-network/WebSocket pairing flow: channel up/down, guide, volume, play/pause, favorites.

### Stream Health
Expose resolution, bitrate, dropped frames, buffer, codec and latency. Add automatic fallback URLs if supplied by the playlist owner.

## Data APIs
Do not hard-code one vendor. Implement adapters. Candidate categories are licensed sports schedule APIs, official league feeds where terms permit, and XMLTV/EPG data supplied by the user/provider. Keep API secrets server-side for the web deployment; Tauri secrets should use OS credential storage where feasible.

## Desktop release work
- Add application icons and metadata.
- Windows CI runner: build MSI/NSIS as supported by Tauri; code-sign with user certificate.
- macOS CI runner: universal or per-arch build, sign with Developer ID, notarize and staple; produce DMG/app bundle.
- GitHub Actions release workflow for tagged builds.
- Auto-updater only after signing infrastructure exists.

## Security
Treat playlists/EPG as untrusted input. Never render provider HTML. Validate URLs/protocols. Avoid logging credentials embedded in playlist URLs. Store secrets outside normal localStorage. Add CSP once required media/API origins are known.

## UX direction
Keep the existing dark broadcast-control-room aesthetic: restrained, dense, keyboard-friendly, fast. The Guide and Sports pages should feel closer to a premium television OS than a generic web dashboard.
