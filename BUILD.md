# Build / Release

## Requirements
Node 20+, npm, Rust stable. Desktop builds also require the Tauri 2 prerequisites for the target OS.

## Web
```bash
npm install
npm run dev
npm run build
```
Deploy `dist/`.

## Windows
Run on Windows with WebView2/Tauri prerequisites:
```powershell
npm install
npm run tauri build
```
Use the resulting Tauri bundle. Add code signing before public distribution.

## macOS
Run on macOS with Xcode Command Line Tools:
```bash
npm install
npm run tauri build
```
For distribution, configure Developer ID signing + Apple notarization. A Linux host cannot produce a properly signed/notarized macOS release.

## Validation note
The source package was generated in a restricted build sandbox. npm registry installation exceeded the sandbox execution timeout, so dependency installation and the final compiled bundles were not falsely marked as verified. Run `npm install && npm run build` on the handoff machine before continuing production work.
