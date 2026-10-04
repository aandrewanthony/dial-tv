/**
 * Settings panels owned by the guide: Sources → "Guide data (XMLTV)" and Mapping → "Guide mapping".
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Link2, RefreshCw, Search, Sparkles, Trash2, Upload } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { orderedChannels, useApp } from '../store/app';
import { kv } from '../store/db';
import { Toggle } from '../components/ui';
import { ChannelPicker } from '../components/ChannelPicker';
import { redactUrl, safeUrl } from '../lib/url';
import { isDesktop } from '../lib/net';
import { fmtCount, guideMatch, loadGuide, useGuide, useGuidePrefs, type GuideRefresh, type PlaylistRefresh } from '../store/guide';
import { MAX_DAYS } from '../workers/epgCore';
import { GuideStatus } from './GuidePage';

const REFRESH_OPTS: [GuideRefresh, string][] = [['6h', 'Every 6 hours'], ['12h', 'Every 12 hours'], ['daily', 'Once a day']];
const PL_OPTS: [PlaylistRefresh, string][] = [['manual', 'Manual'], ['daily', 'Once a day']];

const when = (t?: number) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export function GuideDataPanel() {
  const epgSources = useApp((s) => s.epgSources);
  const update = useApp((s) => s.update);
  const prefs = useGuidePrefs();
  const loadedSources = useGuide((s) => s.sources);
  const [epgUrl, setEpgUrl] = useState('');
  const [err, setErr] = useState<string>();
  const cachedIds = new Set(loadedSources.map((s) => s.id));

  const addEpg = (e: React.FormEvent) => {
    e.preventDefault();
    const u = safeUrl(epgUrl);
    if (!u) return setErr('Enter a valid http(s) URL');
    setErr(undefined);
    update((st) => ({ epgSources: [...st.epgSources, { id: `epg${Date.now()}`, name: new URL(u).hostname, kind: 'xmltv-url', url: u, enabled: true }] }));
    setEpgUrl('');
    // A source the user just added loads right away.
    void loadGuide();
  };
  const addXmltvFile = async (f: File) => {
    const id = `xmltv${Date.now()}`;
    // Stored as the file itself: the guide worker streams (and un-gzips) it, the UI never holds the text.
    if (!(await kv.set(`file:${id}`, f))) return setErr('Could not save the file (storage full?)');
    update((st) => ({ epgSources: [...st.epgSources, { id, name: f.name, kind: 'xmltv-file', enabled: true }] }));
    void loadGuide();
  };

  return (
    <section className="panel" aria-label="Guide data">
      <h2>Guide data (XMLTV)</h2>
      <p className="muted">
        Listings from your provider’s EPG link (often added automatically from the playlist header) or a file. .xml and .xml.gz supported.
        The guide loads automatically online in the background, keeps itself up to date, and opens instantly from this device.
        {!isDesktop() && ' In the browser, the guide host must allow cross-origin requests — the desktop app has no such limit.'}
      </p>
      <GuideStatus />
      {epgSources.map((p) => (
        <div className="srcRow" key={p.id}>
          <Toggle on={p.enabled} label={`Enable guide ${p.name}`} onChange={(v) => update((st) => ({ epgSources: st.epgSources.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)) }))} />
          <div>
            <b>{p.name}</b>
            <small>
              {p.kind === 'xmltv-url' ? redactUrl(p.url!) : 'Local file'}
              {p.programCount != null && ` · ${fmtCount(p.programCount)} listings`}
              {p.lastLoaded ? ` · loaded ${when(p.lastLoaded)}` : ''}
              {p.enabled && !cachedIds.has(p.id) && ' · not loaded yet'}
            </small>
            {p.error && <small className="err"><AlertTriangle /> {p.error}</small>}
          </div>
          <button className="icon" aria-label={`Remove guide ${p.name}`} onClick={() => void useApp.getState().removeEpgSource(p.id)}><Trash2 /></button>
        </div>
      ))}
      <form className="row" onSubmit={addEpg}>
        <input className="field" placeholder="https://provider.example/epg.xml.gz" value={epgUrl} onChange={(e) => setEpgUrl(e.target.value)} />
        <button className="primary" disabled={!epgUrl}><Link2 /> Add URL</button>
      </form>
      <label className="upload small"><Upload /><b>IMPORT XMLTV FILE</b><input type="file" accept=".xml,.xmltv,.gz" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addXmltvFile(f); }} /></label>
      {err && <p className="err">{err}</p>}

      <div className="guidePrefs">
        <div className="setting">
          <div><b>Keep the guide fresh</b><span>The guide re-downloads in the background when the saved copy is older than this.</span></div>
          <div className="chips">
            {REFRESH_OPTS.map(([v, l]) => <button key={v} className={prefs.refresh === v ? 'on' : ''} onClick={() => useGuidePrefs.setState({ refresh: v })}>{l}</button>)}
          </div>
        </div>
        <div className="setting">
          <div><b>Days of listings</b><span>More days use more space and take longer to load. Applies on the next refresh.</span></div>
          <div className="chips">
            {Array.from({ length: MAX_DAYS }, (_, i) => i + 1).map((d) => <button key={d} className={prefs.days === d ? 'on' : ''} onClick={() => useGuidePrefs.setState({ days: d })}>{d}</button>)}
          </div>
        </div>
        <div className="setting">
          <div><b>Refresh playlists</b><span>Playlists load from this device at startup. A new playlist loads right away; “Reload all” above re-downloads them.</span></div>
          <div className="chips">
            {PL_OPTS.map(([v, l]) => <button key={v} className={prefs.playlistRefresh === v ? 'on' : ''} onClick={() => useGuidePrefs.setState({ playlistRefresh: v })}>{l}</button>)}
          </div>
        </div>
      </div>
    </section>
  );
}

const PAGE = 60;

export function GuideMappingPanel() {
  const { channels, channelOrder, hidden, epgManual, xmltvChannels } = useApp(useShallow((s) => ({ channels: s.channels, channelOrder: s.channelOrder, hidden: s.hidden, epgManual: s.epgManual, xmltvChannels: s.xmltvChannels })));
  const update = useApp((s) => s.update);
  const g = useGuide(useShallow((s) => ({ rev: s.rev, loaded: s.loaded, matched: s.matched, liveChannels: s.liveChannels, needsReload: s.needsReload, loading: s.loading })));
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'unmatched' | 'all'>('unmatched');
  const [limit, setLimit] = useState(PAGE);
  const list = useMemo(() => orderedChannels({ channels, channelOrder, hidden }, true), [channels, channelOrder, hidden]);
  const { matcher, resolved, hasListings } = useMemo(() => guideMatch(), [g.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const xmlOptions = useMemo(() => xmltvChannels.map((x) => ({ id: x.id, label: `${x.name} (${x.id})` })), [xmltvChannels]);
  const nameOf = useMemo(() => new Map(xmltvChannels.map((x) => [x.id, x.name])), [xmltvChannels]);

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return list.filter((c) => {
      const r = resolved.get(c.id);
      if (show === 'unmatched' && r && hasListings(r.key)) return false;
      return !n || c.name.toLowerCase().includes(n) || c.rawName?.toLowerCase().includes(n) || (c.tvgId ?? '').toLowerCase().includes(n);
    });
  }, [list, resolved, hasListings, show, q]);
  const unmatchedCount = useMemo(() => list.filter((c) => {
    const r = resolved.get(c.id);
    return !r || !hasListings(r.key);
  }).length, [list, resolved, hasListings]);
  const shown = rows.slice(0, limit);
  const suggestions = useMemo(() => {
    const m = new Map<string, { key: string; name: string; confidence: number }>();
    if (!matcher) return m;
    for (const c of shown) {
      if (resolved.get(c.id)) continue;
      const s = matcher.suggest({ id: c.id, name: c.rawName ?? c.name, tvgId: c.tvgId }, 1)[0];
      if (s) m.set(c.id, s);
    }
    return m;
  }, [shown, matcher, resolved]);

  const setManual = (id: string, key: string | undefined) => update((st) => {
    const m = { ...st.epgManual };
    if (key) m[id] = key; else delete m[id];
    return { epgManual: m };
  });
  const acceptAll = () => {
    if (!matcher) return;
    const add: Record<string, string> = {};
    for (const c of list) {
      if (resolved.get(c.id)) continue;
      const s = matcher.suggest({ id: c.id, name: c.rawName ?? c.name, tvgId: c.tvgId }, 1)[0];
      if (s && s.confidence >= 0.8) add[c.id] = s.key;
    }
    if (Object.keys(add).length) update((st) => ({ epgManual: { ...st.epgManual, ...add } }));
  };

  return (
    <section className="panel" aria-label="Guide mapping">
      <div className="panelHead">
        <h2>Guide mapping</h2>
        {g.loaded && <span className="guideMatchCount"><b>{fmtCount(g.matched)}</b> of {fmtCount(g.liveChannels)} channels have listings · {fmtCount(unmatchedCount)} without</span>}
      </div>
      <p className="muted">Channels match guide channels by tvg-id, then by name (country prefixes like “US|” and quality tags like “FHD” ignored). Pick the right guide channel for any that don’t — it’s remembered.</p>
      {!xmltvChannels.length ? (
        <p className="muted">{g.loaded ? 'The loaded guide has no channels.' : 'Load the guide (Settings → Sources) to map channels.'}</p>
      ) : (
        <>
          <div className="row guideMapTools">
            <label className="guideSearch"><Search /><input placeholder="Search channels" aria-label="Search channels to map" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} /></label>
            <div className="chips">
              <button className={show === 'unmatched' ? 'on' : ''} onClick={() => { setShow('unmatched'); setLimit(PAGE); }}>Without listings</button>
              <button className={show === 'all' ? 'on' : ''} onClick={() => { setShow('all'); setLimit(PAGE); }}>All</button>
            </div>
            <button onClick={acceptAll} title="Map every unmatched channel whose best guess is at least 80% confident"><Sparkles /> Accept confident suggestions</button>
          </div>
          {g.needsReload > 0 && (
            <p className="banner">{g.needsReload} mapped channel{g.needsReload > 1 ? 's have' : ' has'} no listings yet. {g.loading ? 'Loading them now…' : 'They load with the next automatic update.'}</p>
          )}
          {shown.map((c) => {
            const r = resolved.get(c.id);
            const ok = r && hasListings(r.key);
            const sug = suggestions.get(c.id);
            return (
              <div className="mapRow" key={c.id}>
                <div><b>{c.name}</b><small>{c.tvgId ? `tvg-id ${c.tvgId}` : 'no tvg-id'}{c.rawName && c.rawName !== c.name ? ` · ${c.rawName}` : ''}</small></div>
                {r ? (
                  <span className={`conf ${ok ? (r.how === 'similar' ? 'mid' : 'hi') : 'none'}`}>{ok ? `${r.how === 'manual' ? 'manual' : r.how === 'tvg-id' ? 'tvg-id' : r.how === 'name' ? 'name' : 'similar name'} · ${nameOf.get(r.key) ?? r.key}` : 'no listings'}</span>
                ) : sug ? (
                  <button className="conf mid sugBtn" onClick={() => setManual(c.id, sug.key)} title={`Use ${sug.name} (${sug.key})`}>Use {sug.name} · {Math.round(sug.confidence * 100)}%</button>
                ) : (
                  <span className="conf none">no match</span>
                )}
                <ChannelPicker value={epgManual[c.id]} options={xmlOptions} placeholder="— auto —" noneLabel="— auto —" onChange={(id) => setManual(c.id, id)} />
              </div>
            );
          })}
          {rows.length > shown.length && <button onClick={() => setLimit(limit + PAGE * 2)}>Show more ({fmtCount(rows.length - shown.length)} more)</button>}
          {!rows.length && <p className="muted">{show === 'unmatched' ? 'Every channel has listings.' : 'No channels match.'}</p>}
        </>
      )}
    </section>
  );
}
