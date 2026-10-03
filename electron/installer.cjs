// Windows self-installer. Smart App Control blocks unsigned installer .exe files (each build
// is a new, unknown file), so Dial TV ships as a zip of trusted files and installs itself:
// it copies its own folder to %LOCALAPPDATA%\Programs\Dial TV, creates Start menu + desktop
// shortcuts, and registers an "Installed apps" entry whose Uninstall runs `Dial TV.exe --uninstall`.
// No new executable is ever created. Test hooks: DIAL_INSTALL_ROOT, DIAL_SHORTCUT_DIR, DIAL_UNINSTALL_KEY.
const { app, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_ID = 'com.dialtv.player';
const EXE = 'Dial TV.exe';
const UNINSTALL_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

const installRoot = () => process.env.DIAL_INSTALL_ROOT || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Programs', 'Dial TV');
const uninstallKey = () => `${UNINSTALL_ROOT}\\${process.env.DIAL_UNINSTALL_KEY || 'DialTV'}`;
const shortcutDirs = () => process.env.DIAL_SHORTCUT_DIR
  ? [path.join(process.env.DIAL_SHORTCUT_DIR, 'Start Menu'), path.join(process.env.DIAL_SHORTCUT_DIR, 'Desktop')]
  : [path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'), app.getPath('desktop')];
const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const appDir = () => path.dirname(process.execPath);
const flag = (name) => process.argv.includes(name);

function reg(args) {
  return spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), args, { windowsHide: true, encoding: 'utf8' });
}

function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(installRoot(), 'resources', 'app', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function dirSizeKb(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSizeKb(p) * 1024 : fs.statSync(p).size;
  }
  return Math.round(total / 1024);
}

/** Older NSIS-installer builds registered under a generated key; remove those entries. */
function removeLegacyEntries() {
  const q = reg(['query', UNINSTALL_ROOT, '/s', '/f', 'Dial TV', '/d']);
  for (const line of (q.stdout || '').split(/\r?\n/)) {
    const key = line.trim();
    if (!key.startsWith('HKEY_') || key.toLowerCase() === uninstallKey().replace(/^HKCU/, 'HKEY_CURRENT_USER').toLowerCase()) continue;
    const name = reg(['query', key, '/v', 'DisplayName']).stdout || '';
    if (/DisplayName\s+REG_SZ\s+Dial TV\b/.test(name)) reg(['delete', key, '/f']);
  }
}

function createShortcuts(target) {
  const icon = path.join(installRoot(), 'resources', 'icon.ico');
  for (const dir of shortcutDirs()) {
    fs.mkdirSync(dir, { recursive: true });
    shell.writeShortcutLink(path.join(dir, 'Dial TV.lnk'), 'create', {
      target,
      cwd: path.dirname(target),
      icon: fs.existsSync(icon) ? icon : target,
      iconIndex: 0,
      appUserModelId: APP_ID,
      description: 'Dial TV: TV & sports command center',
    });
  }
}

function register(target) {
  const key = uninstallKey();
  const icon = path.join(installRoot(), 'resources', 'icon.ico');
  const values = {
    DisplayName: 'Dial TV',
    DisplayVersion: app.getVersion(),
    Publisher: 'Studio Farms',
    DisplayIcon: fs.existsSync(icon) ? icon : target,
    InstallLocation: installRoot(),
    UninstallString: `"${target}" --uninstall`,
    QuietUninstallString: `"${target}" --uninstall --silent`,
  };
  for (const [k, v] of Object.entries(values)) reg(['add', key, '/v', k, '/t', 'REG_SZ', '/d', v, '/f']);
  reg(['add', key, '/v', 'EstimatedSize', '/t', 'REG_DWORD', '/d', String(dirSizeKb(installRoot())), '/f']);
  for (const k of ['NoModify', 'NoRepair']) reg(['add', key, '/v', k, '/t', 'REG_DWORD', '/d', '1', '/f']);
}

async function install() {
  const root = installRoot();
  const target = path.join(root, EXE);
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  await fs.promises.cp(appDir(), root, { recursive: true, force: true });
  createShortcuts(target);
  if (!process.env.DIAL_INSTALL_ROOT) removeLegacyEntries();
  register(target);
  return target;
}

function uninstall(silent) {
  const root = installRoot();
  if (!silent) {
    const r = dialog.showMessageBoxSync({
      type: 'question',
      title: 'Uninstall Dial TV',
      message: 'Uninstall Dial TV?',
      detail: 'Removes the app and its shortcuts. Your settings, playlists and picks are kept unless you also remove them.',
      buttons: ['Uninstall', 'Uninstall and remove my settings', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (r === 2) return;
    if (r === 1) fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
  }
  for (const dir of shortcutDirs()) fs.rmSync(path.join(dir, 'Dial TV.lnk'), { force: true });
  reg(['delete', uninstallKey(), '/f']);
  // This exe lives in the folder being removed, so the folder is deleted a few seconds after we
  // exit. Child processes die with Electron (Windows job object), so the cleanup is started
  // through WMI as an independent process (cmd.exe and PowerShell are signed Windows tools).
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const cmdLine = `"${path.join(sys, 'cmd.exe')}" /d /c ping -n 4 127.0.0.1 >nul & rmdir /s /q "${root}"`;
  spawnSync(path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}' } | Out-Null`],
  { windowsHide: true, timeout: 15000 });
}

/**
 * Runs before the app starts on Windows. Returns true when this process should quit
 * (it installed/updated and launched the installed copy, or it uninstalled).
 */
async function handleStartup({ hasLock }) {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  const silent = flag('--silent');
  if (flag('--uninstall')) {
    if (!hasLock) {
      dialog.showMessageBoxSync({ type: 'info', title: 'Dial TV', message: 'Close Dial TV first', detail: 'Quit the running Dial TV, then uninstall again.' });
      return true;
    }
    uninstall(silent);
    return true;
  }
  const inPlace = norm(appDir()) === norm(installRoot());
  if (inPlace || flag('--no-install')) return false;
  if (process.env.DIAL_PROFILE && !process.env.DIAL_INSTALL_ROOT && !flag('--install')) return false; // test copies

  const current = installedVersion();
  if (!hasLock) {
    dialog.showMessageBoxSync({
      type: 'info',
      title: 'Dial TV',
      message: current ? `Close Dial TV to update it to ${app.getVersion()}` : 'Dial TV is already running',
      detail: 'Quit the running Dial TV, then open this one again.',
    });
    return true;
  }
  if (!silent && !flag('--install')) {
    const r = dialog.showMessageBoxSync({
      type: 'question',
      title: 'Dial TV',
      message: current ? `Update Dial TV ${current} → ${app.getVersion()}?` : `Install Dial TV ${app.getVersion()}?`,
      detail: current
        ? 'Replaces the installed version. Your settings, playlists and picks are kept.'
        : 'Installs Dial TV for your account with Start menu and desktop shortcuts. You can uninstall it from Settings → Apps.',
      buttons: [current ? 'Update' : 'Install', 'Just run it from here', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (r === 1) return false;
    if (r === 2) return true;
  }
  try {
    const target = await install();
    if (!flag('--no-launch')) spawn(target, [], { detached: true, stdio: 'ignore', cwd: path.dirname(target) }).unref();
    return true;
  } catch (e) {
    dialog.showErrorBox('Dial TV', `Install failed: ${e.message}\n\nYou can still run Dial TV from this folder.`);
    return false;
  }
}

module.exports = { handleStartup, installRoot };
