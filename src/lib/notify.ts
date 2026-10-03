import { isTauri } from './net';

/** Desktop notification via Tauri plugin, else the web Notification API. Silently no-ops if not permitted. */
export async function notify(title: string, body?: string) {
  try {
    if (isTauri()) {
      const n = await import('@tauri-apps/plugin-notification');
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === 'granted';
      if (ok) n.sendNotification({ title, body });
      return;
    }
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') new Notification(title, { body });
  } catch {
    /* notifications are best-effort */
  }
}

export async function requestNotifyPermission(): Promise<boolean> {
  try {
    if (isTauri()) {
      const n = await import('@tauri-apps/plugin-notification');
      return (await n.isPermissionGranted()) || (await n.requestPermission()) === 'granted';
    }
    if (typeof Notification === 'undefined') return false;
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}
