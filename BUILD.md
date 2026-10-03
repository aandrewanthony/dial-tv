# Build, test & release

## Requirements
Node 20+ (22 recommended). Desktop builds also need Rust stable + the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for the OS.

## Develop
```bash
npm install
npm run dev          # web app on http://localhost:1420
npm run tauri dev    # desktop shell (needs Rust)
```

## Test
```bash
npm run typecheck
npm test             # Vitest: parsers, scheduler, mapper, odds grading, adapters, migrations
npx playwright install chromium   # once
npm run test:e2e     # Playwright: navigation, sports, picks, schedule, player, search, mobile
```
E2E mocks ESPN/Sleeper from `tests/fixtures`, so it's deterministic and offline-safe.

## Web deploy
```bash
npm run build        # → dist/
```
Deploy `dist/` to any static host (Netlify, Vercel, Cloudflare Pages, S3). It's a hash-routed SPA, so no rewrite rules are needed.

## Desktop releases (Windows + macOS)
Releases are built by GitHub Actions (`.github/workflows/release.yml`) — push a tag:
```bash
git tag v0.2.0
git push origin v0.2.0
```
That builds a Windows MSI/NSIS installer and a universal macOS app/DMG into a **draft** GitHub release.

Icons are generated in CI from `src-tauri/app-icon.svg` (`npm run tauri:icons`).

### Signing
- **macOS:** add repo secrets `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`. tauri-action signs, notarizes and staples automatically.
- **Windows:** unsigned installers trigger SmartScreen, and PCs with **Smart App Control** may refuse to run them at all. Add a code-signing certificate (`bundle.windows.certificateThumbprint` or `signCommand` in `src-tauri/tauri.conf.json`), or use Azure Trusted Signing.
- Add the Tauri updater only after signing is in place.

### Building locally on Windows
`npm run tauri build` works on a normal Windows dev machine with Rust + WebView2. On machines with Windows Application Control / Smart App Control enforced, the Tauri CLI's native binary is blocked — use the CI workflow instead.
