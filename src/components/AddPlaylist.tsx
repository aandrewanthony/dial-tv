import { useState } from 'react';
import { Link2, Loader2, Upload } from 'lucide-react';
import { useApp } from '../store/app';
import { kv } from '../store/db';
import { safeUrl } from '../lib/url';

/** Add your own M3U playlist by link or file. Used in Settings and on the empty Watch page. */
export function AddPlaylist() {
  const update = useApp((s) => s.update);
  const loading = useApp((s) => s.loadingSources);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string>();

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

  return (
    <div className="addPlaylist">
      <form className="row" onSubmit={addUrl}>
        <input className="field small" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field" placeholder="Playlist link (http://… .m3u / .m3u8)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="primary" disabled={!url || loading}>{loading ? <Loader2 className="spin" /> : <Link2 />} Add link</button>
      </form>
      <label className="upload">
        <Upload /><b>OR CHOOSE AN M3U FILE</b>
        <input type="file" accept=".m3u,.m3u8,.txt" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addFile(f); }} />
      </label>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
