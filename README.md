# Dial TV — Personal TV & Sports Command Center

A fast, keyboard-friendly IPTV player built around live sports. Runs in the browser and as a desktop app for Windows and macOS (Electron). Bring your own playlist: Dial TV plays streams you're authorized to watch and adds a sports layer on top.

## Highlights

| | |
|---|---|
| **Game Day home** | Countdown to your teams' next games, the single best game on right now, tonight's plan, fantasy score, open picks. |
| **Watchability ranking** | Live games scored by how close and late they are + your fantasy exposure + your favorite teams. |
| **Clutch alerts** | Toast (and optional system notification) when a live game gets tight late — one-score 4th quarter, OT, tied in the 9th, one-goal 3rd period. Optional **auto-switch**. |
| **Smart Sports Mapper** | Turns "CBS / ESPN2 / NFL Net" from the schedule into the right channel on *your* playlist, with a confidence score; corrections are remembered. One-click **Watch** on every game. |
| **Live score bug** | When the tuned channel is carrying a live game, a score bug overlays the player. |
| **Fantasy Live (Sleeper)** | Username only (public read-only API). Live matchup board, which games your matchup will be decided in, **red-zone alerts for your starters**, "Multiview my games". |
| **Picks & Odds** | Odds board (spread / moneyline / total, reference lines from ESPN). Pick'em between you and your brother with units, auto-grading at the final whistle, live "covering / sweating", head-to-head view, leaderboard + streaks. No real money, no sportsbook links. |
| **Spoiler shield** | Hide every score app-wide until you hit Reveal — for watching on delay. |
| **Multiview** | 2×2 or 1+3, audio follows the focused tile, "fill with best live games". |
| **Guide** | Virtualized EPG with a true time axis, 30/60/120-min zoom, now line, 8-day picker, sports filter, program drawer. |
| **Planner** | Day timeline with drag/resize, conflict lanes + warnings, reminders, notes, agenda view, **rules** ("every Jets game", "every SportsCenter", "reserve 7–10 PM"). |
| **Built-in decoder** | Desktop apps play broadcast formats browsers can't: MPEG-2 video, AC-3/Dolby, E-AC-3 and MP2 audio, and HEVC on PCs without HEVC support. Each channel is checked when you tune and converted on the fly with a bundled ffmpeg only when needed. Settings → Playback. |
| **Player** | hls.js + mpegts.js (raw `.ts` IPTV, links with or without extensions), auto-retry & playlist fallback URLs, quality / audio / subtitle menus, PiP, theater, fullscreen, stream-health panel, last-channel, channel-number entry, desktop mini-player (always on top). |
| **Everything else** | Global search (Ctrl K), favorites, channel reorder/hide, parental PIN locks, XMLTV import + manual mapping, settings backup/restore, compact mode, accent colors, phone layout, live score ticker. |

Press **?** in the app for keyboard shortcuts.

## Data sources

- **Scores, schedules, broadcasters, odds:** ESPN's public scoreboard endpoints (no key, browser-friendly). Wrapped behind a `SportsProvider` interface so a licensed feed can replace it.
- **Fantasy:** Sleeper public API (`FantasyProvider`). Players list is cached for 24h as Sleeper requests.
- **TV:** your M3U/M3U8 playlist (URL or file) and XMLTV guide (URL or file, `.xml.gz` OK). Playlist header `url-tvg` is picked up automatically.

Everything is stored locally (IndexedDB). Nothing is uploaded.

## Quick start

```bash
npm install
npm run dev        # http://localhost:1420
```

See [BUILD.md](BUILD.md) for tests, web deploy and desktop releases.

> **Browser vs desktop:** browsers require playlist/stream hosts to send CORS headers, and most IPTV providers don't send them. The desktop app works with any provider, and also applies per-channel User-Agent/Referer from the playlist.
