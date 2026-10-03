# CLAUDE HANDOFF — Dial TV

## Mission
Personal TV + sports command center for Web, Windows and macOS with one shared React/TypeScript UI. Primary user is a sports fan. No piracy-oriented discovery, DRM circumvention, credential bypass, or restreaming. Picks are a just-for-fun tracker — no real-money wagering, no sportsbook deep links.

## Architecture (v0.2)
```
src/
  app/          App shell, hash router, global keys, ticker, toasts, PIN gate
  pages/        Home (Game Day), Watch, Guide, Sports, Fantasy, Picks, Multiview, Schedule, Settings
  components/   GameCard + ScoreBug, SearchPalette, TeamPicker, ChannelPicker, ui primitives
  player/       Player (hls.js / mpegts.js / native), TauriLoader (native-HTTP hls loader)
  providers/    types (Playlist/Epg/Sports/Fantasy interfaces), demo (seeded fixture guide), remote (M3U/XMLTV), espn, sleeper
  hooks/        useEngine (polling, clutch/red-zone/reminder alerts, pick grading, rules), useSports (watchability ranking)
  store/        app (zustand, persisted state + migrations), fantasy, db (IndexedDB kv)
  lib/          m3u, xmltv, url (validation/redaction), channelMatch (Smart Sports Mapper), scheduler, sports (clutch, odds, grading), net, notify, seed
tests/unit      Vitest (36)   tests/e2e  Playwright (7, network mocked)   tests/fixtures
src-tauri/      Tauri 2 shell: http + notification plugins, capabilities, CSP
.github/        CI (typecheck/unit/e2e/build) + tagged desktop release (tauri-action)
```

## Done (P0)
- [x] main.tsx split into routes/pages/components/stores
- [x] Robust M3U (attrs incl. quoted commas, tvg-chno, EXTGRP, EXTVLCOPT, Kodi pipe headers, BOM, dupes, unsafe URL rejection, header url-tvg)
- [x] XMLTV parser (tz offsets → UTC, open-ended programmes, sports/new flags, gz) + tvg-id/name/manual mapping UI
- [x] Provider interfaces + ESPN, Sleeper, demo, remote implementations
- [x] Deterministic seeded demo guide
- [x] Scheduler: day timeline, drag/resize (15-min snap), lanes, conflicts, edit modal, notes, reminders, team/title/block rules
- [x] Guide: virtualized rows, true time axis, 30/60/120 zoom, now line, day picker, Now, details drawer
- [x] Player: loading/error/retry, fallback URLs, quality/audio/subs, keys, PiP, theater, last channel, ch up/down, number entry, stream health
- [x] Persistence: IndexedDB (web + Tauri webview), versioned schema + migrate(), v0.1 localStorage import, flush on pagehide
- [x] Tests: parser fixtures, scheduler collisions, mapper, grading, adapters, migrations; Playwright flows

## Done (P1 + sports features)
Favorites, reorder/hide (dnd), global search, sports hub with live/upcoming/final, favorite teams, Game Day countdowns, multiview 2×2 / 1+3, desktop mini-player (always on top), settings import/export, compact mode + accent theme, parental PIN locks, notifications (web + Tauri), clutch alerts + auto-switch, Smart Sports Mapper, live score bug, watchability ranking, Sleeper fantasy (stakes, red-zone alerts), picks/odds tracker, spoiler shield, score ticker.

## Not done / next
- **Remote Control mode** (phone → desktop over LAN WebSocket with pairing). Needs a small Rust WebSocket server in `src-tauri` + a `/remote` route.
- **Multiple fantasy platforms** (ESPN private leagues need cookies; Yahoo needs OAuth — do via a server-side or Tauri-side token store, never localStorage).
- **Win probability chart** — `providers/espn.ts#winProbability` is implemented but not yet charted on the game card.
- **Xtream Codes login** as a source type (player_api.php) — today use the provider's M3U URL.
- **Personal Linear Channel** (local/VOD pseudo-channel) from the original backlog.
- **Windows code signing** + Tauri updater; macOS secrets are wired in `release.yml`.
- Secrets: playlist URLs can embed provider credentials and are stored in IndexedDB. Move to OS keychain via a Tauri plugin (e.g. `tauri-plugin-stronghold` / keyring) for desktop.

## Constraints learned
- ESPN `/teams` lacks CORS → team lists come from `/standings`. Scoreboard date *ranges* return nothing → one request per day.
- Chromium now plays HLS natively; we still prefer hls.js (track menus + stats), native only when MSE is missing (iOS).
- hls.js already retries manifest loads; treat a fatal manifest error as final (→ fallback URL / error UI).
- The dev machine enforces Windows Application Control: the Tauri CLI native binary is blocked locally, so desktop builds run in CI.

## Security
Playlists/EPG are untrusted: http(s)-only URLs, no provider HTML rendered, credentials redacted in UI/stats (`lib/url.ts#redactUrl`), CSP set in `tauri.conf.json`, Tauri HTTP scope limited to http(s).
