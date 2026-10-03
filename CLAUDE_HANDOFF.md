# CLAUDE HANDOFF — Dial TV

## Mission
Personal TV + sports command center for Web, Windows and macOS with one shared React/TypeScript UI. Primary user is a sports fan. No piracy-oriented discovery, DRM circumvention, credential bypass, or restreaming. Picks are a just-for-fun tracker — no real-money wagering, no sportsbook deep links.

## Architecture (v0.2)
```
src/
  app/          App shell, hash router, global keys, ticker, toasts, PIN gate
  pages/        Home (Game Day), Watch, Guide, Sports, Fantasy, Picks, Multiview, Schedule, Settings
  components/   GameCard + ScoreBug, SearchPalette, TeamPicker, ChannelPicker, ui primitives
  player/       Player (hls.js / mpegts.js / native)
  providers/    types (Playlist/Epg/Sports/Fantasy interfaces), remote (M3U/XMLTV), espn, sleeper
  hooks/        useEngine (polling, clutch/red-zone/reminder alerts, pick grading, rules), useSports (watchability ranking)
  store/        app (zustand, persisted state + migrations), fantasy, db (IndexedDB kv)
  lib/          m3u, xmltv, url (validation/redaction), channelMatch (Smart Sports Mapper), scheduler, sports (clutch, odds, grading), net, notify, seed
tests/unit      Vitest (36)   tests/e2e  Playwright (7, network mocked)   tests/fixtures
electron/       Desktop shell (Electron 33.2.0): CORS + UA/Referer injection in its own session, mini player, single instance
build/          Icon source (icon.svg) + generated icon.png / icon.ico (npm run icons)
.github/        CI (typecheck/unit/e2e/build) + desktop.yml (Mac universal DMG on macos runner, Windows installers)
```

## Done (P0)
- [x] main.tsx split into routes/pages/components/stores
- [x] Robust M3U (attrs incl. quoted commas, tvg-chno, EXTGRP, EXTVLCOPT, Kodi pipe headers, BOM, dupes, unsafe URL rejection, header url-tvg)
- [x] XMLTV parser (tz offsets → UTC, open-ended programmes, sports/new flags, gz) + tvg-id/name/manual mapping UI
- [x] Provider interfaces + ESPN, Sleeper, remote (M3U/XMLTV) implementations
- [x] No built-in channels (v0.3): the app starts empty and only plays the user's own M3U link/file; schema v3 migration removes old demo + iptv-org sources
- [x] Scheduler: day timeline, drag/resize (15-min snap), lanes, conflicts, edit modal, notes, reminders, team/title/block rules
- [x] Guide: virtualized rows, true time axis, 30/60/120 zoom, now line, day picker, Now, details drawer
- [x] Player: loading/error/retry, fallback URLs, quality/audio/subs, keys, PiP, theater, last channel, ch up/down, number entry, stream health
- [x] Persistence: IndexedDB (web + Electron), versioned schema + migrate(), v0.1 localStorage import, flush on pagehide
- [x] Tests: parser fixtures, scheduler collisions, mapper, grading, adapters, migrations; Playwright flows

## Done (P1 + sports features)
Favorites, reorder/hide (dnd), global search, sports hub with live/upcoming/final, favorite teams, Game Day countdowns, multiview 2×2 / 1+3, desktop mini-player (always on top), settings import/export, compact mode + accent theme, parental PIN locks, notifications (web + native desktop), clutch alerts + auto-switch, Smart Sports Mapper, live score bug, watchability ranking, Sleeper fantasy (stakes, red-zone alerts), picks/odds tracker, spoiler shield, score ticker.

## Not done / next
- **Remote Control mode** (phone → desktop over LAN WebSocket with pairing). Add a small WebSocket server in `electron/main.cjs` + a `/remote` route.
- **Multiple fantasy platforms** (ESPN private leagues need cookies; Yahoo needs OAuth — do via a server-side or Electron safeStorage token store, never localStorage).
- **Win probability chart** — `providers/espn.ts#winProbability` is implemented but not yet charted on the game card.
- **Xtream Codes login** as a source type (player_api.php) — today use the provider's M3U URL.
- **Personal Linear Channel** (local/VOD pseudo-channel) from the original backlog.
- **Code signing:** Windows cert, and Apple Developer ID + notarization (steps in BUILD.md). Then add electron-updater.
- Secrets: playlist URLs can embed provider credentials and are stored in IndexedDB. Move to the OS keychain via Electron `safeStorage` on desktop.

## Constraints learned
- ESPN `/teams` lacks CORS → team lists come from `/standings`. Scoreboard date *ranges* return nothing → one request per day.
- Chromium now plays HLS natively; we still prefer hls.js (track menus + stats), native only when MSE is missing (iOS).
- hls.js already retries manifest loads; treat a fatal manifest error as final (→ fallback URL / error UI).
- The dev PC enforces Smart App Control. The Tauri CLI native binary is blocked there, so the shell moved to Electron (33.2.0, `signAndEditExecutable: false`); its built exes are verified to run on this PC. Mac builds run on GitHub's macOS runner.

## Security
Playlists/EPG are untrusted: http(s)-only URLs, no provider HTML rendered, credentials redacted in UI/stats (`lib/url.ts#redactUrl`), the Electron renderer is sandboxed with contextIsolation; the preload exposes only `setMiniPlayer` / `version`, and the app never navigates away from its own files.
