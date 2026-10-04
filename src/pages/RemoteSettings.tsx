import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { Toggle } from '../components/ui';
import { desktop } from '../lib/net';
import { encodeQr, qrPath } from '../lib/qr';
import { remoteBridge, type RemoteStatus } from '../lib/remote';

/** QR code as SVG (dark on white, so phones read it in either theme). */
export function QrSvg({ text, label }: { text: string; label?: string }) {
  const q = useMemo(() => { try { return encodeQr(text); } catch { return null; } }, [text]);
  if (!q) return null;
  const n = q.size + 8;
  return (
    <svg className="qrCode" viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" role="img" aria-label={label ?? `QR code: ${text}`}>
      <rect width={n} height={n} fill="#fff" />
      <path d={qrPath(q)} fill="#000" />
    </svg>
  );
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : new Date(t).toLocaleDateString();
};

/** Settings → Remote (desktop only): turn the phone remote on, pair phones, revoke them. */
export function RemoteSettings() {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const b = remoteBridge();
    if (!b) return;
    let alive = true;
    void b.status().then((s) => { if (alive) setSt(s); });
    const off = b.onStatus((s) => { if (alive) setSt(s); });
    return () => { alive = false; off(); };
  }, []);
  const b = remoteBridge();
  if (!b) return null;
  const run = async (fn: () => Promise<RemoteStatus | null>) => {
    setBusy(true);
    try { const s = await fn(); if (s) setSt(s); } finally { setBusy(false); }
  };
  const platform = desktop()?.platform;
  const enabled = !!st?.enabled;
  return (
    <div className="settingsCol remoteSettings">
      <section className="panel">
        <h2>Remote control</h2>
        <p className="muted">Use your phone as a remote: channel up/down, number pad, play/pause, volume, last channel, guide and your favorites. The phone must be on the same Wi-Fi as this computer. Nothing goes over the internet.</p>
        <div className="setting">
          <div><b>Phone remote</b><span>Runs a small server on your home network while this is on. Off by default.</span></div>
          <Toggle label="Phone remote" on={enabled} onChange={(v) => void run(() => b.setEnabled(v))} />
        </div>
        {busy && !st?.on && enabled && <p className="muted">Starting…</p>}
        {st?.error && <p className="err">{st.error}</p>}
        {st?.on && st.url && (
          <div className="remotePair">
            <QrSvg text={st.url} label="QR code for the remote page" />
            <div className="remotePairInfo">
              <span className="muted small">1. Scan with your phone’s camera, or open</span>
              <b className="remoteUrl" data-testid="remote-url">{st.url}</b>
              {st.urls.length > 1 && <span className="muted small">Other addresses on this computer: {st.urls.slice(1).join(' · ')}</span>}
              <span className="muted small">2. Enter this pairing code on the phone (once — it remembers)</span>
              <b className="remoteCode" data-testid="remote-code" aria-label="Pairing code">{st.code}</b>
              <button className="ghost" disabled={busy} onClick={() => void run(() => b.newCode())}><RefreshCw /> New code</button>
            </div>
          </div>
        )}
        <p className="muted small remoteHelp">
          {platform === 'darwin'
            ? 'The first time you turn this on, macOS may ask whether Dial TV can accept incoming network connections — choose Allow.'
            : 'The first time you turn this on, Windows Firewall asks whether Dial TV may use your network — allow it on Private networks. If your phone can’t connect, make sure this Wi-Fi is set to Private (not Public) in Windows network settings.'}
          {' '}Each code works for one phone and changes after it’s used or after too many wrong tries. Turn the remote off when you don’t need it.
        </p>
      </section>
      <section className="panel">
        <h2>Paired phones</h2>
        {!st?.devices.length ? <p className="muted">No phones paired yet.</p> : (
          <div className="remoteDevices">
            {st.devices.map((d) => (
              <div key={d.id} className="remoteDevice">
                <Smartphone />
                <div><b>{d.name}</b><small>{d.connected ? 'Connected' : `Last used ${ago(d.lastSeen)}`}</small></div>
                <button className="ghost danger" disabled={busy} onClick={() => void run(() => b.revoke(d.id))}><Trash2 /> Remove</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
