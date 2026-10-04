import { useState } from 'react';
import { KeyRound, Link2, Loader2, Lock, Upload } from 'lucide-react';
import { useApp } from '../store/app';
import { kv } from '../store/db';
import { redactUrl, safeUrl } from '../lib/url';
import { secretsAreEncrypted } from '../lib/secrets';
import { parseXtreamServer, xtreamLogin } from '../providers/xtream';
import type { PlaylistSource, XtreamAccount, XtreamLogin } from '../types';
import { GroupPickerAuto } from './channels/GroupPicker';

type Mode = 'm3u' | 'xtream';

const fmtDate = (t: number) => new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

/** "Expires Mar 3, 2027 · 2 connections" from Xtream user_info (empty when nothing is known). */
export function accountSummary(a: XtreamAccount | undefined, maxConnections?: number): string {
  const parts: string[] = [];
  if (a?.status && a.status.toLowerCase() !== 'active') parts.push(a.status);
  if (a?.expiresAt) parts.push(`${a.expiresAt < Date.now() ? 'Expired' : 'Expires'} ${fmtDate(a.expiresAt)}`);
  else if (a && a.status?.toLowerCase() === 'active') parts.push('No expiry date');
  if (a?.isTrial) parts.push('Trial');
  const max = maxConnections ?? a?.maxConnections;
  if (max != null) parts.push(`${max} connection${max === 1 ? '' : 's'}${a?.activeConnections != null ? ` (${a.activeConnections} in use)` : ''}`);
  return parts.join(' · ');
}

/** Second line of a playlist row in Settings: where it comes from, without any login. */
export function playlistDetail(p: PlaylistSource): string {
  if (p.kind === 'm3u-file') return 'Local file';
  if (p.kind === 'xtream') {
    const host = p.xtream?.server ? redactUrl(p.xtream.server).replace(/\/$/, '') : 'Xtream Codes';
    const acct = accountSummary(p.account, p.maxConnections);
    return `Xtream Codes · ${host}${acct ? ` · ${acct}` : ''}`;
  }
  return p.url ? redactUrl(p.url) : 'Playlist link';
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Add your own playlist: M3U link or file, or an Xtream Codes login. Used in Settings and on the empty Watch page. */
export function AddPlaylist({ pickAfterAdd = true }: { pickAfterAdd?: boolean } = {}) {
  const update = useApp((s) => s.update);
  const loading = useApp((s) => s.loadingSources);
  const [mode, setMode] = useState<Mode>('m3u');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [output, setOutput] = useState<NonNullable<XtreamLogin['output']>>('auto');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [info, setInfo] = useState<string>();

  const addUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = safeUrl(url);
    if (!u) return setErr('Enter a valid http(s) link');
    setErr(undefined);
    update((st) => ({ playlists: [...st.playlists, { id: `pl${Date.now()}`, name: name.trim() || new URL(u).hostname, kind: 'm3u-url', url: u, enabled: true }] }));
    setName('');
    setUrl('');
    await useApp.getState().loadSources();
  };

  const addFile = async (f: File) => {
    const id = `m3u${Date.now()}`;
    await kv.set(`file:${id}`, await f.text());
    update((st) => ({ playlists: [...st.playlists, { id, name: f.name, kind: 'm3u-file', enabled: true }] }));
    await useApp.getState().loadSources();
  };

  // A pasted get.php / player_api.php link fills in the username and password too.
  const onServer = (v: string) => {
    setServer(v);
    const p = /[?&](username|password)=/.test(v) ? parseXtreamServer(v) : null;
    if (p?.username && p.password) {
      setServer(p.server);
      setUsername(p.username);
      setPassword(p.password);
    }
  };

  const addXtream = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseXtreamServer(server);
    if (!parsed) return setErr('Enter the server address, e.g. http://provider.example:8080');
    const user = username.trim();
    if (!user || !password) return setErr('Enter your username and password');
    if (CONTROL.test(user) || CONTROL.test(password)) return setErr('The username or password has characters that are not allowed');
    setErr(undefined);
    setInfo(undefined);
    setBusy(true);
    const login: XtreamLogin = { server: parsed.server, username: user, password, output };
    try {
      // Check the login first: a wrong password shows here instead of as a broken playlist.
      const account = await xtreamLogin(login);
      const id = `xc${Date.now()}`;
      update((st) => ({
        playlists: [...st.playlists, {
          id, name: name.trim() || new URL(parsed.server).hostname, kind: 'xtream', xtream: login, account,
          ...(account.maxConnections != null ? { maxConnections: account.maxConnections } : {}), enabled: true,
        }],
      }));
      setName('');
      setServer('');
      setUsername('');
      setPassword('');
      setInfo(['Logged in.', accountSummary(account)].filter(Boolean).join(' '));
      await useApp.getState().loadSources();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tab = (m: Mode, label: string) => (
    <button type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => { setMode(m); setErr(undefined); setInfo(undefined); }}>{label}</button>
  );

  return (
    <div className="addPlaylist">
      <div className="chips addPlaylistTabs" role="tablist" aria-label="Playlist type">
        {tab('m3u', 'M3U link / file')}
        {tab('xtream', 'Xtream Codes login')}
      </div>
      {mode === 'm3u' ? (
        <>
          <form className="row" onSubmit={addUrl}>
            <input className="field small" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="field" placeholder="Playlist link (http://… .m3u / .m3u8)" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="primary" disabled={!url || loading}>{loading ? <Loader2 className="spin" /> : <Link2 />} Add link</button>
          </form>
          <label className="upload">
            <Upload /><b>OR CHOOSE AN M3U FILE</b>
            <input type="file" accept=".m3u,.m3u8,.txt" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addFile(f); }} />
          </label>
        </>
      ) : (
        <form className="xtreamForm" onSubmit={addXtream} aria-label="Xtream Codes login">
          <div className="row">
            <input className="field small" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="field" aria-label="Server" placeholder="Server (http://provider.example:8080)" value={server} onChange={(e) => onServer(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <div className="row">
            <input className="field" aria-label="Username" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />
            <input className="field" aria-label="Password" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <select className="field small" aria-label="Stream format" value={output} onChange={(e) => setOutput(e.target.value as typeof output)}>
              <option value="auto">Format: auto</option>
              <option value="ts">MPEG-TS (.ts)</option>
              <option value="m3u8">HLS (.m3u8)</option>
            </select>
            <button className="primary" disabled={!server || !username || !password || busy || loading}>{busy || loading ? <Loader2 className="spin" /> : <KeyRound />} Log in</button>
          </div>
          <p className="muted small xtreamNote">
            <Lock /> {secretsAreEncrypted()
              ? 'Your password is stored encrypted with your operating system’s keychain.'
              : 'Web version: your login is stored in this browser’s storage. The desktop app keeps it in the OS keychain.'}
            {' '}Live channels, movies and the guide load from your provider’s account.
          </p>
        </form>
      )}
      {err && <p className="err">{err}</p>}
      {info && <p className="muted small">{info}</p>}
      {/* Big playlist just added (here in Settings): offer "Choose your channels" right away. */}
      {pickAfterAdd && <GroupPickerAuto />}
    </div>
  );
}
