# CLAUDE HANDOFF — Dial TV

## Mission
Personal TV + sports command center for Web, Windows and macOS with one shared React/TypeScript UI. Primary user is a sports fan. No piracy-oriented discovery, DRM circumvention, credential bypass, or restreaming. Bets: multi-sportsbook odds (The Odds API, user-supplied key stored in the OS keychain), open-in-sportsbook deep links (no affiliate params), a real-bet tracker, and responsible-gambling tools (loss/stake limits, take-a-break, 1-800-GAMBLER). Dial TV never places bets or handles money.

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

## v0.6 (TV / Sports split)
- Navigation: TV (Live TV, Guide, Movies & Series, My Channels, Multiview) and Sports (Game Day, Scores, My Teams, Fantasy, Bets); Smart Schedule + Settings shared. No scores ticker (removed at the owner's request).
- VOD: lib/content.ts classifies playlist entries (live / movie / series). Movies & Series library (components/tv/*, store/tv.ts). The Player has VOD props (vod, startAt, onProgress, onEnded) with VodControls, and the decoder seeks with -ss.
- Cable mode: guide overlay over live TV (G), info banner (B / Enter), personal scheduled channels (lib/personalSchedule.ts, numbers 900+; real durations are learned as items play).
- Playback: player/tuning.ts maps Settings → Playback (buffer, computer, hw accel, resolution, start quality, deinterlace) to hls.js / mpegts.js / decoder configs. player/gate.ts holds playback until a cushion builds after a stall. The decoder picks its x264 preset by computer level and detects a hardware encoder (nvenc / qsv / amf / videotoolbox).
- Sports: Bets (providers/oddsapi.ts, store/bets.ts, components/sports/*), onboarding + My Teams, ESPN Fantasy (public leagues) + Sleeper, Smart Schedule planner (lib/scheduler.ts) with auto-tune. Pick'em removed (schema v5).
- Feature stores use store/persisted.ts; API keys use lib/secrets.ts (safeStorage on desktop).
- Private ESPN leagues (desktop only): Fantasy → ESPN → "Private league" takes espn_s2 + SWID (never the password). They're saved as write-only secrets (`dial:secret-get` refuses them; `dial:secret-has` checks them) and `electron/espnAuth.cjs` + main.cjs add the Cookie header only to the app's https fetches to lm-api-reads.fantasy.espn.com / fantasy.espn.com (stripped if a redirect carries it elsewhere). `FantasyConfig.espnPrivate` marks the league; rejected cookies raise `EspnFantasyError` code 'auth' and the page shows the cookie form again. The web build explains that the desktop app is needed.
- Stream lab: tests/streamlab/check.mjs plays movie files through Movies & Series; buffer.mjs measures stalls on simulated bad networks (/net/jitter, /net/slow); vod.mjs tests VOD seek/startAt.
- Win probability: GameCard has a toggle (live/final, non-compact, not behind the spoiler shield) that opens components/WinProbability.tsx: lazy ESPN summary fetch, per-game cache, 60 s refresh while live, inline SVG (lib/winProb.ts). Games ESPN has no data for hide the toggle.
- Unit tests: tests/unit/playback-tuning.test.ts (player/tuning.ts) and playback-decoder-args.test.ts (decoder sanitizeOptions / videoEncoderArgs / transcodeArgs).

## Not done / next
- Phase 2: a Dial TV-hosted fantasy league (needs a server and accounts; the owner wants it).
- HLS buffering on jittery networks is not improved yet (the lab's HLS channel also throws a Chromium decode error in the baseline).
- **Multiple fantasy platforms** (Yahoo needs OAuth — do via a server-side or Electron safeStorage token store, never localStorage).
- Xtream series (get_series + one get_series_info per show) are not loaded; Xtream movies and live are. Multiview should respect `PlaylistSource.maxConnections`.
- **Personal Linear Channel** (local/VOD pseudo-channel) from the original backlog.
- **Code signing:** Windows cert, and Apple Developer ID + notarization (steps in BUILD.md). Then add electron-updater.
- Secrets: imported M3U *files* (`file:<id>` in IndexedDB) can still contain provider logins in their stream URLs.

## v0.8 (Xtream Codes + playlist logins in the keychain)
- Xtream Codes login (providers/xtream.ts): server + username + password in Add Playlist. player_api.php (auth, live categories/streams, VOD categories/streams) maps onto the same Channel shape as parseM3U; xmltv.php becomes the playlist's guide source. Account status/expiry/max connections from user_info are on the playlist record (`account`, `maxConnections`).
- Schema v6. store/sourceSecrets.ts: on desktop, playlist links, Xtream passwords and guide links are saved in the OS keychain (lib/secrets.ts) and the IndexedDB copy carries only `keychain: true`; the channel cache stores stream URLs with login placeholders. Web is unchanged. The move happens on the first save after loading, only after the keychain write succeeded (lossless). Settings export leaves logins out unless "Include playlist links and logins" is checked; import reuses this device's logins for the same source ids.

## v0.8 (light theme, sports rail, DVR)
- **Light theme:** Settings → Appearance → Theme (dark / light / match computer). `scripts/light-theme.mjs` is a PostCSS plugin (vite.config.ts) that appends a `:root[data-theme="light"]` copy of every colour rule in src/style.css with colours re-mapped (greys flipped on a curve, vivid colours / black / white / scrims kept); hand-tuned core tokens in `LIGHT_TOKENS`. Keep writing CSS for the dark theme; prefer the tokens. index.html sets data-theme before paint from localStorage `dialtv.theme`.
- **Live TV rail:** compact rows; groups folded by country (home country open, `channelPrefs.railFolds`); a Sports section (`lib/sportsOf.ts`, `components/channels/useSportRail.ts`) with every sport listed (empty ones greyed out at the end): channels by name for Sports-category channels, plus "on now" from the guide programme or a live ESPN game matched to the channel.
- **DVR (desktop):** `electron/dvr.cjs` (state in userData/dvr.json, stream links encrypted with safeStorage), `src/lib/dvr.ts`, `components/tv/RecordButton.tsx` (Live TV, Guide drawer, guide overlay), `pages/RecordingsPage.tsx` (#/recordings, desktop only). ffmpeg stream-copies into MPEG-TS parts (restarts on drops), then joins into a faststart MP4 (keeps .ts if that fails). Guard rails: max simultaneous (1–4), 8 h max, 2 GB free to start / stop under 1 GB, interrupted recordings kept as partial, delete = Recycle Bin. Playback via a token-protected 127.0.0.1 server that serves only recorded files. Lab: `node tests/streamlab/dvr.mjs` (real ffmpeg; drop/restart/partial/range checks).
- **DVR rules (desktop):** `src/lib/dvrRules.ts` (persisted store `feature:dvrRules` + pure planners `planTeams` / `planSeries` + runner, started from App.tsx). Rules stay in the renderer; the shell only gets concrete recordings tagged `rule: { id, label, key }` (UI shows "Auto: Lions"). Auto-record my teams (off by default, per-team switches on the Recordings page): favourite-team games in `useApp.games` (~7 days) → `matchBroadcasts` channel → kickoff − padBefore to sport length (`GAME_MINUTES`) + padAfter; game still live near the end → `dvr:extend` (max +90 min over the original end; ffmpeg continues into a new part). Moved / re-matched scheduled games are cancelled + removed and re-made; a game or airing that already has a recording in any state (incl. user-cancelled) isn't scheduled again. Series: "Record series" in the Guide drawer / guide overlay (title, case-insensitive; this channel only by default or any channel; new episodes only), re-evaluated on every guide change, max 30 upcoming per rule. Overlaps beyond "at once" are still scheduled (shell queues) with a toast + the row warning. Shell dupe check now treats < 50 % overlap on a channel as a different show (back-to-back padded episodes).

## Built-in decoder (v0.4)
`electron/decoder.cjs` probes each stream with the bundled ffmpeg (`resources/ffmpeg`) and, when Chromium can't decode its codecs, serves an H.264/AAC MPEG-TS conversion from a token-protected 127.0.0.1 server. The player (`src/player/Player.tsx`) probes in parallel with direct playback. It switches when the codecs are unsupported, when playback errors, or when picture or sound bytes aren't decoding (silent AC-3 / MPEG-2 failures). Channels that needed the decoder are remembered (`settings.decoderChannels`). Verified with `tests/streamlab` (13/13 formats on Windows packaged build; CI runs it on packaged Mac arm64 + x64).

## Remote Control (v0.8)
Phone remote over the LAN, desktop only, off by default (Settings → Remote). `electron/remoteCore.cjs` = pure pairing/token/rate-limit/WS framing (unit tested); `electron/remote.cjs` = HTTP + hand-rolled WebSocket server (no deps; ports 47800–47804, then any free port), serves `electron/remote-page.html` (self-contained phone UI); `electron/remoteMain.cjs` = IPC + `userData/remote.json` ({ enabled, devices } with SHA-256 token hashes only) + stop on quit. Pairing: 6-digit code, single use; 5 wrong tries per address → 5-min lockout; 10 wrong tries overall → new code. Every WS message carries the token; revoke closes the socket. Host header must be an IP literal (anti DNS-rebinding), Origin must match. Renderer: `src/lib/remote.ts` (types, command routing/queue, `applyRemoteCommand`), Live TV registers the handler and publishes now-playing + favorites; `src/lib/qr.ts` is an offline QR encoder (byte mode, level M, v1–10).
Second screen: when the tuned channel shows a live game, now-playing also carries `game` (score bug, situation, latest 15 plays newest first, penalties as "Offensive Holding · MIA · P.Paul · 10 yards"); the phone shows a Game tab and vibrates on a new score or flag. `src/lib/penalty.ts#useGameFeed` is the ONE ESPN summary poller (20 s) for both the penalty toasts and the phone; it runs only for a live game on screen when penalty alerts apply (NFL/NCAAF/NHL) or a paired phone is connected (`useRemotePhoneConnected`; feed leagues add NBA/WNBA/NCAAM/MLB, soccer = score only). Spoiler shield → teams only. `remoteMain.cjs#sanitizeGame` whitelists the game fields.

## Constraints learned
- ESPN `/teams` lacks CORS → team lists come from `/standings`. Scoreboard date *ranges* return nothing → one request per day.
- Chromium now plays HLS natively; we still prefer hls.js (track menus + stats), native only when MSE is missing (iOS).
- hls.js already retries manifest loads; treat a fatal manifest error as final (→ fallback URL / error UI).
- The dev PC enforces Smart App Control. The Tauri CLI native binary is blocked there, so the shell moved to Electron (33.2.0, `signAndEditExecutable: false`); its built exes are verified to run on this PC. Mac builds run on GitHub's macOS runner.

## Security
Playlists/EPG are untrusted: http(s)-only URLs, no provider HTML rendered, credentials redacted in UI/stats (`lib/url.ts#redactUrl`), the Electron renderer is sandboxed with contextIsolation; the preload exposes a small explicit bridge (`setMiniPlayer`, `version`, secrets, decoder, stream headers, `remote` — commands arrive pre-validated by the main process), and the app never navigates away from its own files.
