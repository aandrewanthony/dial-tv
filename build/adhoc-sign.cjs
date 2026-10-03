// electron-builder afterSign hook: without an Apple Developer ID, ad-hoc sign the
// macOS app with Apple's codesign so it runs on Apple Silicon (unsigned arm64 code is
// refused). Signs the bundled ffmpeg first (it lives in Resources, which --deep skips),
// then the app. Runs before the DMG/zip are created.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // real Developer ID signing configured
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const ffmpeg = path.join(app, 'Contents', 'Resources', 'ffmpeg', 'ffmpeg');
  if (fs.existsSync(ffmpeg)) {
    console.log(`  • ad-hoc signing  ${ffmpeg}`);
    execFileSync('codesign', ['--force', '--sign', '-', ffmpeg], { stdio: 'inherit' });
  }
  console.log(`  • ad-hoc signing  ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
