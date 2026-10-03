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
Output: `release/Dial-TV-<ver>-win.zip`. **There is deliberately no installer .exe.** Smart App Control
blocks unsigned installer and portable executables, because every build is a new file Windows has never seen.
The zip holds only trusted files:
- `Dial TV.exe` is byte-for-byte the official Electron 33.2.0 exe (`signAndEditExecutable` and `asar` are off).
- `resources/ffmpeg/ffmpeg.exe` is the stock ffmpeg-static build.

**Self-installer** (`electron/installer.cjs`): the user extracts the zip and opens `Dial TV.exe`, which offers to
Install/Update. It then copies itself to `%LOCALAPPDATA%ProgramsDial TV`, creates Start menu and desktop
shortcuts, and registers an Installed-apps entry whose Uninstall runs `Dial TV.exe --uninstall`. It replaces older
NSIS-installed copies and their uninstall entries. Verify the whole cycle with
`powershell -File tests/install/win-install-test.ps1` (mark of the web → install → shortcuts → launch → update →
uninstall → zero Smart App Control blocks; uses isolated locations).

## Mac app (built by GitHub Actions on a real Mac)
Workflow: `.github/workflows/desktop.yml`. GitHub → **Actions → Desktop apps → Run workflow**, or push a tag:
```bash
git tag v0.2.0 && git push origin v0.2.0
```
Downloads: the run's **Artifacts** (`Dial-TV-mac` has the `.dmg` + `.zip`). A tag also attaches them to a draft release.
There are separate Apple Silicon (`arm64`) and Intel (`x64`) apps, each with a matching ffmpeg, all ad-hoc signed. The workflow checks the signature and launches the app before uploading.

### First launch on the Mac (one time)
Without a paid Apple Developer ID ($99/yr), macOS can't verify the developer:
- **macOS 15 Sequoia or newer:** open Dial TV once, click **Done**, then go to **System Settings → Privacy & Security** and click **Open Anyway** next to Dial TV.
- **macOS 14 or older:** right-click Dial TV in Applications → **Open** → **Open**.

To remove this prompt for good, add a Developer ID: repo secrets `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, then in `package.json → build.mac` set
`"identity"` to your certificate name, `"hardenedRuntime": true` and `"notarize": true`.

## Stream lab (playback format tests)
Tests real playback of every broadcast format against a desktop build: MPEG-2 1080i + AC-3, MPEG-2 + MP2,
H.264 + AC-3 / E-AC-3, HEVC, H.264 + AAC, MPEG-2 over HLS. Each one is tested with and without a file extension.
A channel passes only if picture AND sound are decoding and playback is advancing.
```bash
node tests/streamlab/generate.mjs          # makes test media with the bundled ffmpeg
node tests/streamlab/server.mjs &          # serves it like an IPTV provider on :8787
DIAL_PROFILE=lab "release/win-unpacked/Dial TV.exe" --remote-debugging-port=9341 &
node tests/streamlab/check.mjs 9341        # 13 channels: picture + sound
node tests/streamlab/soak.mjs 9341 90      # real-time pace, ffmpeg cleanup, 4x multiview (Windows)
```
CI runs the same check on the packaged Mac apps on Apple Silicon and Intel runners before releasing.

## Web deploy
`npm run build` → deploy `dist/` to any static host. In a browser, IPTV hosts must allow CORS; the desktop apps don't need that.
