# Build, test & release

Desktop apps use **Electron 33.2.0** + electron-builder. (Tauri was dropped: its build tool is blocked by
Windows Smart App Control on our dev PC, and Mac apps can only be built on a Mac anyway.)

## Develop
```bash
npm install
npm run dev            # web app on http://localhost:1420
npm run desktop:dev    # desktop window with hot reload
npm run desktop        # desktop window from a production build
```

## Test
```bash
npm run typecheck
npm test               # Vitest unit tests
npx playwright install chromium   # once
npm run test:e2e       # Playwright flows (ESPN/Sleeper mocked)
```

## Windows app (build on this PC)
```bash
npm run dist:win
```
Output in `release/`:
- `Dial-TV-Setup-<ver>.exe`: installer (Start menu + desktop shortcut, uninstaller).
- `Dial-TV-Portable-<ver>.exe`: single file, no install.
- `Dial TV-<ver>-win.zip`: unzip-and-run folder.

`signAndEditExecutable` is off and `asar` is off, so `Dial TV.exe` is byte-for-byte the official Electron 33.2.0 exe. Smart App Control trusts that file. With asar on, electron-builder patches an integrity stamp into the exe, every build gets a new unknown hash, and Smart App Control blocks it (seen with 0.3.0). The build and both exes have been
verified to run on this PC with Smart App Control enforced. Without a code-signing certificate, Windows SmartScreen
may show "Windows protected your PC". Click **More info → Run anyway** once.

## Mac app (built by GitHub Actions on a real Mac)
Workflow: `.github/workflows/desktop.yml`. GitHub → **Actions → Desktop apps → Run workflow**, or push a tag:
```bash
git tag v0.2.0 && git push origin v0.2.0
```
Downloads: the run's **Artifacts** (`Dial-TV-mac` has the `.dmg` + `.zip`). A tag also attaches them to a draft release.
The app is universal (Apple Silicon + Intel) and ad-hoc signed. The workflow checks the signature and launches the app before uploading.

### First launch on the Mac (one time)
Without a paid Apple Developer ID ($99/yr), macOS can't verify the developer:
- **macOS 15 Sequoia or newer:** open Dial TV once, click **Done**, then go to **System Settings → Privacy & Security** and click **Open Anyway** next to Dial TV.
- **macOS 14 or older:** right-click Dial TV in Applications → **Open** → **Open**.

To remove this prompt for good, add a Developer ID: repo secrets `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, then in `package.json → build.mac` set
`"identity"` to your certificate name, `"hardenedRuntime": true` and `"notarize": true`.

## Web deploy
`npm run build` → deploy `dist/` to any static host. In a browser, IPTV hosts must allow CORS; the desktop apps don't need that.
