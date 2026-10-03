import { useMemo, useState } from 'react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import {
  AlertTriangle, Download, Eye, EyeOff, GripVertical, Heart, Link2, Loader2, Lock, RefreshCw, Trash2, Unlock, Upload,
} from 'lucide-react';
import { migrate, orderedChannels, pickPersisted, sha256, useApp } from '../store/app';
import { kv } from '../store/db';
import type { Channel } from '../types';
import { ChannelMark, Toggle } from '../components/ui';
import { ChannelPicker } from '../components/ChannelPicker';
import { canonicalNetwork, matchNetwork } from '../lib/channelMatch';
import { redactUrl, safeUrl } from '../lib/url';
import { LEAGUES } from '../lib/sports';
import { requestNotifyPermission } from '../lib/notify';
import { useRoute, navigate } from '../app/router';
import { isDesktop } from '../lib/net';

type Tab = 'sources' | 'channels' | 'mapping' | 'sports' | 'parental' | 'appearance' | 'backup';
const TABS: [Tab, string][] = [
  ['sources', 'Sources'], ['channels', 'Channels'], ['mapping', 'Mapping'], ['sports', 'Sports & alerts'],
  ['parental', 'Parental'], ['appearance', 'Appearance'], ['backup', 'Backup'],
];

export default function SettingsPage() {
  const { param } = useRoute();
  const tab = (TABS.some(([t]) => t === param) ? param : 'sources') as Tab;
  return (
    <div className="settingsPage">
      <div className="chips tabs">
        {TABS.map(([t, l]) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => navigate('settings', t)}>{l}</button>)}
      </div>
      {tab === 'sources' && <Sources />}
      {tab === 'channels' && <Channels />}
      {tab === 'mapping' && <Mapping />}
      {tab === 'sports' && <SportsSettings />}
      {tab === 'parental' && <Parental />}
      {tab === 'appearance' && <Appearance />}
      {tab === 'backup' && <Backup />}
    </div>
  );
}

const IPTV_ORG = [
  { name: 'Free sports', size: '~450', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' },
  { name: 'Free US channels', size: '~1,450', url: 'https://iptv-org.github.io/iptv/countries/us.m3u' },
  { name: 'News', size: '~800', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
  { name: 'Everything', size: '~11,000', url: 'https://iptv-org.github.io/iptv/index.m3u' },
];

function Sources() {
  const s = useApp();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  const [err, setErr] = useState<string>();

  const addPlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = safeUrl(url);
    if (!u) return setErr('Enter a valid http(s) URL');
    setErr(undefined);
    s.update((st) => ({ playlists: [...st.playlists, { id: `pl${Date.now()}`, name: name || new URL(u).hostname, kind: 'm3u-url', url: u, enabled: true }] }));
    setName('');
    setUrl('');
    await useApp.getState().loadSources();
  };
  const addPreset = async (presetName: string, presetUrl: string) => {
    s.update((st) => ({ playlists: [...st.playlists, { id: `pl${Date.now()}`, name: presetName, kind: 'm3u-url', url: presetUrl, enabled: true }] }));
    await useApp.getState().loadSources();
  };
  const addEpg = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = safeUrl(epgUrl);
    if (!u) return setErr('Enter a valid http(s) URL');
    s.update((st) => ({ epgSources: [...st.epgSources, { id: `epg${Date.now()}`, name: new URL(u).hostname, kind: 'xmltv-url', url: u, enabled: true }] }));
    setEpgUrl('');
    await useApp.getState().loadSources();
  };
  const addFile = async (f: File, kind: 'm3u' | 'xmltv') => {
    const id = `${kind}${Date.now()}`;
    await kv.set(`file:${id}`, await f.text());
    if (kind === 'm3u') s.update((st) => ({ playlists: [...st.playlists, { id, name: f.name, kind: 'm3u-file', enabled: true }] }));
    else s.update((st) => ({ epgSources: [...st.epgSources, { id, name: f.name, kind: 'xmltv-file', enabled: true }] }));
    await useApp.getState().loadSources();
  };

  return (
    <div className="settingsCol">
      <section className="panel">
        <div className="panelHead">
          <h2>Playlists</h2>
          <button onClick={() => void s.loadSources()} disabled={s.loadingSources}>{s.loadingSources ? <Loader2 className="spin" /> : <RefreshCw />} Reload all</button>
        </div>
        <p className="muted">M3U/M3U8 playlists from providers you subscribe to. Everything stays on this device.{!isDesktop() && ' In the browser, the playlist host must allow cross-origin requests — the desktop app has no such limit.'}</p>
        {s.playlists.map((p) => (
          <div className="srcRow" key={p.id}>
            <Toggle on={p.enabled} onChange={(v) => { s.update((st) => ({ playlists: st.playlists.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)) })); setTimeout(() => void useApp.getState().loadSources(), 0); }} />
            <div>
              <b>{p.name}</b>
              <small>{p.kind === 'm3u-url' ? redactUrl(p.url!) : p.kind === 'm3u-file' ? 'Local file' : 'Built-in'}{p.channelCount != null && ` · ${p.channelCount} channels`}</small>
              {p.error && <small className="err"><AlertTriangle /> {p.error}</small>}
            </div>
            {p.kind !== 'demo' && <button className="icon" aria-label="Remove" onClick={() => { s.update((st) => ({ playlists: st.playlists.filter((x) => x.id !== p.id) })); void kv.del(`file:${p.id}`); setTimeout(() => void useApp.getState().loadSources(), 0); }}><Trash2 /></button>}
          </div>
        ))}
        <div className="presets">
          <b>Free channels from iptv-org</b>
          <small className="muted">Community list of publicly available free streams. Some streams go offline or are region-locked; it doesn't carry cable networks like ESPN or FOX.</small>
          <div className="row">
            {IPTV_ORG.map((p) => {
              const added = s.playlists.some((x) => x.url === p.url);
              return <button key={p.url} disabled={added || s.loadingSources} onClick={() => void addPreset(p.name, p.url)}>{added ? `✓ ${p.name}` : `+ ${p.name}`} <small className="muted">{p.size}</small></button>;
            })}
          </div>
        </div>
        <form className="row" onSubmit={addPlaylist}>
          <input className="field small" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="field" placeholder="https://provider.example/playlist.m3u" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="primary" disabled={!url}><Link2 /> Add URL</button>
        </form>
        <label className="upload"><Upload /><b>IMPORT M3U FILE</b><input type="file" accept=".m3u,.m3u8,.txt" onChange={(e) => e.target.files?.[0] && void addFile(e.target.files[0], 'm3u')} /></label>
      </section>

      <section className="panel">
        <h2>Guide data (XMLTV)</h2>
        <p className="muted">Listings from your provider’s EPG URL (often added automatically from the playlist header). .xml and .xml.gz supported.</p>
        {s.epgSources.map((p) => (
          <div className="srcRow" key={p.id}>
            <Toggle on={p.enabled} onChange={(v) => { s.update((st) => ({ epgSources: st.epgSources.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)) })); setTimeout(() => void useApp.getState().loadSources(), 0); }} />
            <div>
              <b>{p.name}</b>
              <small>{p.kind === 'xmltv-url' ? redactUrl(p.url!) : p.kind === 'xmltv-file' ? 'Local file' : 'Built-in'}{p.programCount != null && ` · ${p.programCount} listings`}</small>
              {p.error && <small className="err"><AlertTriangle /> {p.error}</small>}
            </div>
            {p.kind !== 'demo' && <button className="icon" aria-label="Remove" onClick={() => { s.update((st) => ({ epgSources: st.epgSources.filter((x) => x.id !== p.id) })); void kv.del(`file:${p.id}`); setTimeout(() => void useApp.getState().loadSources(), 0); }}><Trash2 /></button>}
          </div>
        ))}
        <form className="row" onSubmit={addEpg}>
          <input className="field" placeholder="https://provider.example/epg.xml.gz" value={epgUrl} onChange={(e) => setEpgUrl(e.target.value)} />
          <button className="primary" disabled={!epgUrl}><Link2 /> Add URL</button>
        </form>
        <label className="upload small"><Upload /><b>IMPORT XMLTV FILE</b><input type="file" accept=".xml,.xmltv" onChange={(e) => e.target.files?.[0] && void addFile(e.target.files[0], 'xmltv')} /></label>
        {err && <p className="err">{err}</p>}
      </section>
    </div>
  );
}

function SortRow({ c }: { c: Channel }) {
  const s = useApp();
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: c.id });
  const hidden = s.hidden.includes(c.id);
  const locked = s.settings.locked.includes(c.id);
  const fav = s.favorites.includes(c.id);
  const toggle = (key: 'hidden' | 'favorites', on: boolean) => s.update((st) => ({ [key]: on ? st[key].filter((x) => x !== c.id) : [...st[key], c.id] }));
  return (
    <div ref={setNodeRef} className={`chRow ${hidden ? 'hiddenCh' : ''}`} style={{ transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined, transition }}>
      <span className="grip" {...attributes} {...listeners}><GripVertical /></span>
      <ChannelMark channel={c} size={30} />
      <span className="num">{c.number}</span>
      <b>{c.name}</b>
      <small>{c.group}</small>
      <button className={`icon ${fav ? 'on' : ''}`} title="Favorite" onClick={() => toggle('favorites', fav)}><Heart fill={fav ? 'currentColor' : 'none'} /></button>
      <button className="icon" title={hidden ? 'Show' : 'Hide'} onClick={() => toggle('hidden', hidden)}>{hidden ? <EyeOff /> : <Eye />}</button>
      <button className={`icon ${locked ? 'on' : ''}`} title={locked ? 'Unlock' : 'Lock (needs PIN)'} onClick={() => s.update((st) => ({ settings: { ...st.settings, locked: locked ? st.settings.locked.filter((x) => x !== c.id) : [...st.settings.locked, c.id] } }))}>{locked ? <Lock /> : <Unlock />}</button>
    </div>
  );
}

function Channels() {
  const s = useApp();
  const [q, setQ] = useState('');
  const all = useMemo(() => orderedChannels(s, true), [s.channels, s.channelOrder, s.hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = all.filter((c) => !q || `${c.name} ${c.group} ${c.number}`.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = all.map((c) => c.id);
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    s.set({ channelOrder: arrayMove(ids, from, to) });
  };
  return (
    <section className="panel">
      <div className="panelHead">
        <h2>Channels · {all.length}</h2>
        <div className="row">
          <input className="field small" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="ghost" onClick={() => s.set({ channelOrder: [] })}>Reset order</button>
        </div>
      </div>
      <p className="muted small">Drag to reorder, hide channels you never watch, lock channels behind the parental PIN.{all.length > 300 && ' Showing the first 300 — filter to find others.'}</p>
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shown.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="chList">{shown.map((c) => <SortRow key={c.id} c={c} />)}</div>
        </SortableContext>
      </DndContext>
    </section>
  );
}

function Mapping() {
  const s = useApp();
  const channels = useMemo(() => orderedChannels(s), [s.channels, s.channelOrder, s.hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  const networks = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const g of Object.values(s.games)) for (const b of g.broadcasts) {
      const c = canonicalNetwork(b);
      const cur = m.get(c);
      m.set(c, { label: cur?.label ?? b, count: (cur?.count ?? 0) + 1 });
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [s.games]);
  const progCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of s.programs) m.set(p.channelId, (m.get(p.channelId) ?? 0) + 1);
    return m;
  }, [s.programs]);
  const chOptions = useMemo(() => channels.map((c) => ({ id: c.id, label: `${c.number} · ${c.name}` })), [channels]);
  const xmlOptions = useMemo(() => s.xmltvChannels.map((x) => ({ id: x.id, label: `${x.name} (${x.id})` })), [s.xmltvChannels]);
  const noGuide = channels.filter((c) => !progCount.get(c.id)).slice(0, 200);

  return (
    <div className="settingsCol">
      <section className="panel">
        <h2>Smart Sports Mapper</h2>
        <p className="muted">Games list their broadcasters (“CBS”, “ESPN2”, “NFL Net”). Dial TV matches those to your playlist with aliases and shows its confidence. Fix any guess and it’s remembered.</p>
        {!networks.length && <p className="muted">Networks appear here once scores load.</p>}
        {networks.map(([canon, { label, count }]) => {
          const m = matchNetwork(label, channels, s.networkOverrides);
          const manual = s.networkOverrides[canon];
          return (
            <div className="mapRow" key={canon}>
              <div><b>{label}</b><small>{count} game{count > 1 ? 's' : ''}</small></div>
              <span className={`conf ${m ? (m.confidence >= 0.9 ? 'hi' : 'mid') : 'none'}`}>{m ? `${Math.round(m.confidence * 100)}% ${m.reason}` : 'no match'}</span>
              <ChannelPicker
                value={manual ?? m?.channel.id}
                options={chOptions}
                placeholder="— not on my playlist —"
                noneLabel="— not on my playlist / auto —"
                onChange={(id) => s.update((st) => {
                  const o = { ...st.networkOverrides };
                  if (id) o[canon] = id; else delete o[canon];
                  return { networkOverrides: o };
                })}
              />
            </div>
          );
        })}
      </section>
      <section className="panel">
        <h2>Guide mapping</h2>
        <p className="muted">Channels without listings. Pick the matching XMLTV channel — saved and applied on the next reload.</p>
        {!s.xmltvChannels.length ? <p className="muted">Add an XMLTV source to map guide data.</p> : noGuide.map((c) => (
          <div className="mapRow" key={c.id}>
            <div><b>{c.name}</b><small>{c.tvgId ? `tvg-id ${c.tvgId}` : 'no tvg-id'}</small></div>
            <ChannelPicker
              value={s.epgManual[c.id]}
              options={xmlOptions}
              onChange={(id) => s.update((st) => {
                const m = { ...st.epgManual };
                if (id) m[c.id] = id; else delete m[c.id];
                return { epgManual: m };
              })}
            />
          </div>
        ))}
        {s.xmltvChannels.length > 0 && <button onClick={() => void s.loadSources()}><RefreshCw /> Apply &amp; reload guide</button>}
      </section>
    </div>
  );
}

function SportsSettings() {
  const s = useApp();
  const set = (p: Partial<typeof s.settings>) => s.update((st) => ({ settings: { ...st.settings, ...p } }));
  return (
    <div className="settingsCol">
      <section className="panel">
        <h2>Leagues</h2>
        <div className="chips">
          {LEAGUES.map((l) => (
            <button key={l.id} className={s.leagues.includes(l.id) ? 'on' : ''} onClick={() => s.update((st) => ({ leagues: st.leagues.includes(l.id) ? st.leagues.filter((x) => x !== l.id) : [...st.leagues, l.id] }))}>{l.label}</button>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>Alerts</h2>
        <div className="setting"><div><b>Clutch alerts</b><span>Pop up when a live game gets close late (one-score 4th quarter, OT, tied in the 9th…)</span></div><Toggle on={s.settings.clutchAlerts} onChange={(v) => set({ clutchAlerts: v })} /></div>
        <div className="setting"><div><b>Auto-switch</b><span>Jump the player to a clutch game automatically when it involves your team or is a thriller</span></div><Toggle on={s.settings.autoSwitch} onChange={(v) => set({ autoSwitch: v })} /></div>
        <div className="setting"><div><b>System notifications</b><span>Reminders, clutch and red-zone alerts even when the window is in the background</span></div>
          <Toggle on={s.settings.notifications} onChange={async (v) => set({ notifications: v ? await requestNotifyPermission() : false })} /></div>
        <div className="setting"><div><b>Spoiler shield</b><span>Hide scores everywhere until you tap Reveal on a game — for watching on delay</span></div><Toggle on={s.settings.spoilerShield} onChange={(v) => set({ spoilerShield: v, revealed: v ? [] : s.settings.revealed })} /></div>
      </section>
    </div>
  );
}

function Parental() {
  const s = useApp();
  const [pin, setPin] = useState('');
  return (
    <section className="panel">
      <h2>Parental lock</h2>
      <p className="muted">Lock channels in Settings → Channels. Locked channels ask for this PIN once per session.</p>
      {s.settings.lockPin ? (
        <div className="row">
          <span>PIN is set · {s.settings.locked.length} locked channel(s)</span>
          <button className="ghost danger" onClick={() => s.update((st) => ({ settings: { ...st.settings, lockPin: undefined }, unlocked: false }))}>Remove PIN</button>
        </div>
      ) : (
        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (pin.length >= 4) { const h = await sha256(pin); s.update((st) => ({ settings: { ...st.settings, lockPin: h } })); setPin(''); } }}>
          <input className="field small" type="password" inputMode="numeric" placeholder="4+ digit PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          <button className="primary" disabled={pin.length < 4}>Set PIN</button>
        </form>
      )}
    </section>
  );
}

const ACCENTS = ['#ff4d4d', '#ff8a1f', '#f5c518', '#2ecc71', '#1fb6ff', '#7c5cff', '#ff4fa3', '#e8e8e8'];

function Appearance() {
  const s = useApp();
  const set = (p: Partial<typeof s.settings>) => s.update((st) => ({ settings: { ...st.settings, ...p } }));
  return (
    <section className="panel">
      <h2>Appearance</h2>
      <div className="setting"><div><b>Density</b><span>Compact fits more rows in the guide and lists</span></div>
        <div className="chips">{(['comfortable', 'compact'] as const).map((d) => <button key={d} className={s.settings.density === d ? 'on' : ''} onClick={() => set({ density: d })}>{d}</button>)}</div>
      </div>
      <div className="setting"><div><b>Accent</b><span>Live dots, highlights and buttons</span></div>
        <div className="swatches">{ACCENTS.map((c) => <button key={c} aria-label={c} className={s.settings.accent === c ? 'on' : ''} style={{ background: c }} onClick={() => set({ accent: c })} />)}</div>
      </div>
    </section>
  );
}

function Backup() {
  const s = useApp();
  const [msg, setMsg] = useState<string>();
  const exportBundle = () => {
    const data = pickPersisted(useApp.getState());
    const blob = new Blob([JSON.stringify({ app: 'dial-tv', exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dial-tv-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importBundle = async (f: File) => {
    try {
      const j = JSON.parse(await f.text());
      if (j?.app !== 'dial-tv' || !j.data) throw new Error('Not a Dial TV backup');
      useApp.setState(migrate(j.data));
      await useApp.getState().loadSources();
      setMsg('Backup restored.');
    } catch (e) {
      setMsg(`Import failed: ${(e as Error).message}`);
    }
  };
  return (
    <section className="panel">
      <h2>Backup &amp; transfer</h2>
      <p className="muted">Export favorites, schedule, rules, picks, mappings and source list to a JSON file — use it to move settings between the web app and desktop. Playlist URLs may contain your provider login, so keep the file private. Imported local playlist files must be re-added.</p>
      <div className="row">
        <button className="primary" onClick={exportBundle}><Download /> Export settings</button>
        <label className="btnLike"><Upload /> Import settings<input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && void importBundle(e.target.files[0])} /></label>
      </div>
      {msg && <p>{msg}</p>}
      <p className="muted small">Schema v{s.version}</p>
    </section>
  );
}
