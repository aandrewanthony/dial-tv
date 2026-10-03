/** System notification via the web Notification API (native toasts in the desktop app). Best-effort. */
export async function notify(title: string, body?: string) {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') new Notification(title, { body });
  } catch {
    /* notifications are best-effort */
  }
}

export async function requestNotifyPermission(): Promise<boolean> {
  try {
    if (typeof Notification === 'undefined') return false;
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}
