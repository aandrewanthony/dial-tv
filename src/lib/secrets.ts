import { desktop } from './net';

/**
 * API keys and tokens. Desktop: encrypted with the OS keychain via the shell.
 * Web: browser localStorage (readable by anyone using this browser profile; the UI says so).
 */
const LS = 'dial-tv:secret:';
type SecretsBridge = { get(name: string): Promise<string | null>; set(name: string, value: string | null): Promise<boolean> };
const bridge = () => (desktop() as unknown as { secrets?: SecretsBridge } | undefined)?.secrets;

export const secretsAreEncrypted = () => !!bridge();

export async function getSecret(name: string): Promise<string | null> {
  const b = bridge();
  if (b) return b.get(name);
  try { return localStorage.getItem(LS + name); } catch { return null; }
}

export async function setSecret(name: string, value: string | null): Promise<boolean> {
  const b = bridge();
  if (b) return b.set(name, value);
  try {
    if (value) localStorage.setItem(LS + name, value);
    else localStorage.removeItem(LS + name);
    return true;
  } catch {
    return false;
  }
}
