import { memo, useMemo, useState } from 'react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import {
  AlertTriangle, Download, Eye, EyeOff, GripVertical, Heart, Link2, Loader2, Lock, RefreshCw, Trash2, Unlock, Upload,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { migrate, orderedChannels, pickPersisted, resetAllData, sha256, useApp, type Settings } from '../store/app';
import { kv } from '../store/db';
import type { Channel } from '../types';
import { ChannelMark, Toggle, usePinGuard } from '../components/ui';
import { ChannelPicker } from '../components/ChannelPicker';
import { AddPlaylist } from '../components/AddPlaylist';
import { canonicalNetwork, matchNetwork } from '../lib/channelMatch';
import { redactUrl, safeUrl } from '../lib/url';
import { LEAGUES } from '../lib/sports';
import { requestNotifyPermission } from '../lib/notify';
import { useRoute, navigate } from '../app/router';
import { isDesktop } from '../lib/net';

type Tab = 'sources' | 'channels' | 'mapping' | 'playback' | 'sports' | 'parental' | 'appearance' | 'backup';
const TABS: [Tab, string][] = [
  ['sources', 'Sources'], ['channels', 'Channels'], ['mapping', 'Mapping'], ['playback', 'Playback'], ['sports', 'Sports & alerts'],
  ['parental', 'Parental'], ['appearance', 'Appearance'], ['backup', 'Backup'],
];

const reload = () => setTimeout(() => void useApp.getState().loadSources(), 0);
const setSettings = (p: Partial<Settings>) => useApp.getState().update((st) => ({ settings: { ...st.settings, ...p } }));
const useOrdered = (includeHidden = false) => {
  const { channels, channelOrder, hidden } = useApp(useShallow((s) => ({ channels: s.channels, channelOrder: s.channelOrder, hidden: s.hidden })));
  return useMemo(() => orderedChannels({ channels, channelOrder, hidden }, includeHidden), [channels, channelOrder, hidden, includeHidden]);
};

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
      {tab === 'playback' && <Playback />}
      {tab === 'sports' && <SportsSettings />}
      {tab === 'parental' && <Parental />}
      {tab === 'appearance' && <Appearance />}
      {tab === 'backup' && <Backup />}
    </div>
  );
}

function Sources() {
  const playlists = useApp((s) => s.playlists);
  const epgSources = useApp((s) => s.epgSources);
  const loading = useApp((s) => s.loadingSources);
  const update = useApp((s) => s.update);
  const [epgUrl, setEpgUrl] = useState('');
  const [err, setErr] = useState<string>();

  const addEpg = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = safeUrl(epgUrl);
    if (!u) return setErr('Enter a valid http(s) URL');
    update((st) => ({ epgSources: [...st.epgSources, { id: `epg${Date.now()}`, name: new URL(u).hostname, kind: 'xmltv-url', url: u, enabled: true }] }));
    setEpgUrl('');
    await useApp.getState().loadSources();
  };
  const addXmltvFile = async (f: File) => {
    const id = `xmltv${Date.now()}`;
    await kv.set(`file:${id}`, await f.text());
    update((st) => ({ epgSources: [...st.epgSources, { id, name: f.name, kind: 'xmltv-file', enabled: true }] }));
    await useApp.getState().loadSources();
  };
  const removeEpg = (id: string) => {
    // Prefer the store action when available (it also cleans up dependent state).
    const rm = (useApp.getState() as { removeEpgSource?: (id: string) => unknown }).removeEpgSource;
    if (rm) { void rm(id); return; }
    update((st) => ({ epgSources: st.epgSources.filter((x) => x.id !== id) }));
    void kv.del(`file:${id}`);
    reload();
  };
  const removePlaylist = (id: string) => {
    const rm = (useApp.getState() as { removePlaylist?: (id: string) => unknown }).removePlaylist;
    if (rm) { void rm(id); return; }
    update((st) => ({ playlists: st.playlists.filter((x) => x.id !== id) }));
    void kv.del(`file:${id}`);
    reload();
  };

  return (
    <div className="settingsCol">
      <section className="panel">
        <div className="panelHead">
          <h2>Playlists</h2>
          <button onClick={() => void useApp.getState().loadSources()} disabled={loading}>{loading ? <Loader2 className="spin" /> : <RefreshCw />} Reload all</button>
        </div>
        <p className="muted">Your M3U/M3U8 playlists, by link or file. Everything stays on this device.{!isDesktop() && ' In the browser, the playlist host must allow cross-origin requests — the desktop app has no such limit.'}</p>
        {playlists.map((p) => (
          <div className="srcRow" key={p.id}>
            <Toggle on={p.enabled} label={`Enable playlist ${p.name}`} onChange={(v) => { update((st) => ({ playlists: st.playlists.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)) })); reload(); }} />
            <div>
              <b>{p.name}</b>
              <small>{p.kind === 'm3u-url' ? redactUrl(p.url!) : 'Local file'}{p.channelCount != null && ` · ${p.channelCount} channels`}</small>
              {p.error && <small className="err"><AlertTriangle /> {p.error}</small>}
            </div>
            <button className="icon" aria-label={`Remove playlist ${p.name}`} onClick={() => removePlaylist(p.id)}><Trash2 /></button>
          </div>
        ))}
        {!playlists.length && <p className="muted">No playlists yet — add yours below.</p>}
        <AddPlaylist />
      </section>

      <section className="panel">
        <h2>Guide data (XMLTV)</h2>
        <p className="muted">Listings from your provider’s EPG URL (often added automatically from the playlist header). .xml and .xml.gz supported.</p>
        {epgSources.map((p) => (
          <div className="srcRow" key={p.id}>
            <Toggle on={p.enabled} label={`Enable guide ${p.name}`} onChange={(v) => { update((st) => ({ epgSources: st.epgSources.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)) })); reload(); }} />
            <div>
              <b>{p.name}</b>
              <small>{p.kind === 'xmltv-url' ? redactUrl(p.url!) : 'Local file'}{p.programCount != null && ` · ${p.programCount} listings`}</small>
              {p.error && <small className="err"><AlertTriangle /> {p.error}</small>}
            </div>
            <button className="icon" aria-label={`Remove guide ${p.name}`} onClick={() => removeEpg(p.id)}><Trash2 /></button>
          </div>
        ))}
        <form className="row" onSubmit={addEpg}>
          <input className="field" placeholder="https://provider.example/epg.xml.gz" value={epgUrl} onChange={(e) => setEpgUrl(e.target.value)} />
          <button className="primary" disabled={!epgUrl}><Link2 /> Add URL</button>
        </form>
        <label className="upload small"><Upload /><b>IMPORT XMLTV FILE</b><input type="file" accept=".xml,.xmltv" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addXmltvFile(f); }} /></label>
        {err && <p className="err">{err}</p>}
      </section>
    </div>
  );
}

const SortRow = memo(function SortRow({ c, guard }: { c: Channel; guard: (fn: () => void) => void }) {
  const hidden = useApp((s) => s.hidden.includes(c.id));
  const locked = useApp((s) => s.settings.locked.includes(c.id));
  const fav = useApp((s) => s.favorites.includes(c.id));
  const update = useApp((s) => s.update);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: c.id });
  const toggle = (key: 'hidden' | 'favorites', on: boolean) => update((st) => ({ [key]: on ? st[key].filter((x) => x !== c.id) : [...st[key], c.id] }));
  // Changing a lock needs the PIN (when one is set).
  const toggleLock = () => guard(() => update((st) => ({
    settings: { ...st.settings, locked: st.settings.locked.includes(c.id) ? st.settings.locked.filter((x) => x !== c.id) : [...st.settings.locked, c.id] },
  })));
  return (
    <div ref={setNodeRef} className={`chRow ${hidden ? 'hiddenCh' : ''}`} style={{ transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined, transition }}>
      <span className="grip" {...attributes} {...listeners}><GripVertical /></span>
      <ChannelMark channel={c} size={30} />
      <span className="num">{c.number}</span>
      <b>{c.name}</b>
      <small>{c.group}</small>
      <button className={`icon ${fav ? 'on' : ''}`} title="Favorite" onClick={() => toggle('favorites', fav)}><Heart fill={fav ? 'currentColor' : 'none'} /></button>
      <button className="icon" title={hidden ? 'Show' : 'Hide'} onClick={() => toggle('hidden', hidden)}>{hidden ? <EyeOff /> : <Eye />}</button>
      <button className={`icon ${locked ? 'on' : ''}`} title={locked ? 'Unlock' : 'Lock (needs PIN)'} onClick={toggleLock}>{locked ? <Lock /> : <Unlock />}</button>
    </div>
  );
});

function Channels() {
  const [q, setQ] = useState('');
  const [guard, pinModal] = usePinGuard();
  const all = useOrdered(true);
  const shown = useMemo(() => {
    const n = q.toLowerCase();
    return all.filter((c) => !n || `${c.name} ${c.group} ${c.number}`.toLowerCase().includes(n)).slice(0, 300);
  }, [all, q]);
  const ids = useMemo(() => shown.map((c) => c.id), [shown]);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const all_ = all.map((c) => c.id);
    const from = all_.indexOf(String(e.active.id));
    const to = all_.indexOf(String(e.over.id));
    useApp.setState({ channelOrder: arrayMove(all_, from, to) });
  };
  return (
    <section className="panel">
      <div className="panelHead">
        <h2>Channels · {all.length}</h2>
        <div className="row">
          <input className="field small" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="ghost" onClick={() => useApp.setState({ channelOrder: [] })}>Reset order</button>
        </div>
      </div>
      <p className="muted small">Drag to reorder, hide channels you never watch, lock channels behind the parental PIN.{all.length > 300 && ' Showing the first 300 — filter to find others.'}</p>
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="chList">{shown.map((c) => <SortRow key={c.id} c={c} guard={guard} />)}</div>
        </SortableContext>
      </DndContext>
      {pinModal}
    </section>
  );
}

function Mapping() {
  const channels = useOrdered();
  const games = useApp((s) => s.games);
  const programs = useApp((s) => s.programs);
  const overrides = useApp((s) => s.networkOverrides);
  const epgManual = useApp((s) => s.epgManual);
  const xmltvChannels = useApp((s) => s.xmltvChannels);
  const update = useApp((s) => s.update);
  const networks = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const g of Object.values(games)) for (const b of g.broadcasts) {
      const c = canonicalNetwork(b);
      const cur = m.get(c);
      m.set(c, { label: cur?.label ?? b, count: (cur?.count ?? 0) + 1 });
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [games]);
  // Matching scans every channel per network: do it once per data change.
  const matches = useMemo(() => networks.map(([canon, v]) => ({ canon, ...v, m: matchNetwork(v.label, channels, overrides) })), [networks, channels, overrides]);
  const progCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of programs) m.set(p.channelId, (m.get(p.channelId) ?? 0) + 1);
    return m;
  }, [programs]);
  const chOptions = useMemo(() => channels.map((c) => ({ id: c.id, label: `${c.number} · ${c.name}` })), [channels]);
  const xmlOptions = useMemo(() => xmltvChannels.map((x) => ({ id: x.id, label: `${x.name} (${x.id})` })), [xmltvChannels]);
  const noGuide = useMemo(() => channels.filter((c) => !progCount.get(c.id)).slice(0, 200), [channels, progCount]);

  return (
    <div className="settingsCol">
      <section className="panel">
        <h2>Smart Sports Mapper</h2>
        <p className="muted">Games list their broadcasters (“CBS”, “ESPN2”, “NFL Net”). Dial TV matches those to your playlist with aliases and shows its confidence. Fix any guess and it’s remembered.</p>
        {!networks.length && <p className="muted">Networks appear here once scores load.</p>}
        {matches.map(({ canon, label, count, m }) => {
          const manual = overrides[canon];
          return (
            <div className="mapRow" key={canon}>
              <div><b>{label}</b><small>{count} game{count > 1 ? 's' : ''}</small></div>
              <span className={`conf ${m ? (m.confidence >= 0.9 ? 'hi' : 'mid') : 'none'}`}>{m ? `${Math.round(m.confidence * 100)}% ${m.reason}` : 'no match'}</span>
              <ChannelPicker
                value={manual ?? m?.channel.id}
                options={chOptions}
                placeholder="— not on my playlist —"
                noneLabel="— not on my playlist / auto —"
                onChange={(id) => update((st) => {
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
        {!xmltvChannels.length ? <p className="muted">Add an XMLTV source to map guide data.</p> : noGuide.map((c) => (
          <div className="mapRow" key={c.id}>
            <div><b>{c.name}</b><small>{c.tvgId ? `tvg-id ${c.tvgId}` : 'no tvg-id'}</small></div>
            <ChannelPicker
              value={epgManual[c.id]}
              options={xmlOptions}
              onChange={(id) => update((st) => {
                const m = { ...st.epgManual };
                if (id) m[c.id] = id; else delete m[c.id];
                return { epgManual: m };
              })}
            />
          </div>
        ))}
        {xmltvChannels.length > 0 && <button onClick={() => void useApp.getState().loadSources()}><RefreshCw /> Apply &amp; reload guide</button>}
      </section>
    </div>
  );
}

function Playback() {
  const decoder = useApp((s) => s.settings.decoder);
  const n = useApp((s) => s.settings.decoderChannels.length);
  return (
    <section className="panel">
      <h2>Playback</h2>
      <div className="setting">
        <div>
          <b>Built-in decoder</b>
          <span>{isDesktop()
            ? 'Converts channels the player can\x27t play directly (MPEG-2 video, AC-3 / Dolby, E-AC-3, MP2 audio, and HEVC on PCs without HEVC support). Auto checks each channel and switches only when needed.'
            : 'Available in the Windows and Mac apps. The web version can\x27t convert video formats.'}</span>
        </div>
        <div className="chips">
          {([['auto', 'Auto'], ['always', 'Always'], ['off', 'Off']] as const).map(([v, l]) => (
            <button key={v} disabled={!isDesktop()} className={decoder === v ? 'on' : ''} onClick={() => setSettings({ decoder: v })}>{l}</button>
          ))}
        </div>
      </div>
      <div className="setting">
        <div><b>Channels using the decoder</b><span>{n ? `${n} channel${n > 1 ? 's' : ''} start with the decoder because they needed it before.` : 'None yet.'}</span></div>
        <button className="ghost" disabled={!n} onClick={() => setSettings({ decoderChannels: [] })}>Reset</button>
      </div>
    </section>
  );
}

function SportsSettings() {
  const leagues = useApp((s) => s.leagues);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.update);
  return (
    <div className="settingsCol">
      <section className="panel">
        <h2>Leagues</h2>
        <div className="chips">
          {LEAGUES.map((l) => (
            <button key={l.id} className={leagues.includes(l.id) ? 'on' : ''} onClick={() => update((st) => ({ leagues: st.leagues.includes(l.id) ? st.leagues.filter((x) => x !== l.id) : [...st.leagues, l.id] }))}>{l.label}</button>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>Alerts</h2>
        <div className="setting"><div><b>Clutch alerts</b><span>Pop up when a live game gets close late (one-score 4th quarter, OT, tied in the 9th…)</span></div><Toggle label="Clutch alerts" on={settings.clutchAlerts} onChange={(v) => setSettings({ clutchAlerts: v })} /></div>
        <div className="setting"><div><b>Auto-switch</b><span>Jump the player to a clutch game automatically when it involves your team or is a thriller</span></div><Toggle label="Auto-switch" on={settings.autoSwitch} onChange={(v) => setSettings({ autoSwitch: v })} /></div>
        <div className="setting"><div><b>System notifications</b><span>Reminders, clutch and red-zone alerts even when the window is in the background</span></div>
          <Toggle label="System notifications" on={settings.notifications} onChange={async (v) => setSettings({ notifications: v ? await requestNotifyPermission() : false })} /></div>
        <div className="setting"><div><b>Spoiler shield</b><span>Hide scores everywhere until you tap Reveal on a game — for watching on delay</span></div><Toggle label="Spoiler shield" on={settings.spoilerShield} onChange={(v) => setSettings({ spoilerShield: v, revealed: v ? [] : settings.revealed })} /></div>
      </section>
    </div>
  );
}

function Parental() {
  const lockPin = useApp((s) => s.settings.lockPin);
  const lockedCount = useApp((s) => s.settings.locked.length);
  const update = useApp((s) => s.update);
  const [pin, setPin] = useState('');
  // Removing the PIN always asks for it, even if this session is unlocked.
  const [guard, pinModal] = usePinGuard(true);
  return (
    <section className="panel">
      <h2>Parental lock</h2>
      <p className="muted">Lock channels in Settings → Channels. Locked channels ask for this PIN once per session.</p>
      {lockPin ? (
        <div className="row">
          <span>PIN is set · {lockedCount} locked channel(s)</span>
          <button className="ghost danger" onClick={() => guard(() => update((st) => ({ settings: { ...st.settings, lockPin: undefined }, unlocked: false })))}>Remove PIN</button>
        </div>
      ) : (
        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (pin.length >= 4) { const h = await sha256(pin); update((st) => ({ settings: { ...st.settings, lockPin: h } })); setPin(''); } }}>
          <input className="field small" type="password" inputMode="numeric" placeholder="4+ digit PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          <button className="primary" disabled={pin.length < 4}>Set PIN</button>
        </form>
      )}
      {pinModal}
    </section>
  );
}

const ACCENTS = ['#ff4d4d', '#ff8a1f', '#f5c518', '#2ecc71', '#1fb6ff', '#7c5cff', '#ff4fa3', '#e8e8e8'];

function Appearance() {
  const density = useApp((s) => s.settings.density);
  const accent = useApp((s) => s.settings.accent);
  return (
    <section className="panel">
      <h2>Appearance</h2>
      <div className="setting"><div><b>Density</b><span>Compact fits more rows in the guide and lists</span></div>
        <div className="chips">{(['comfortable', 'compact'] as const).map((d) => <button key={d} className={density === d ? 'on' : ''} onClick={() => setSettings({ density: d })}>{d}</button>)}</div>
      </div>
      <div className="setting"><div><b>Accent</b><span>Live dots, highlights and buttons</span></div>
        <div className="swatches">{ACCENTS.map((c) => <button key={c} aria-label={c} className={accent === c ? 'on' : ''} style={{ background: c }} onClick={() => setSettings({ accent: c })} />)}</div>
      </div>
    </section>
  );
}

function Backup() {
  const version = useApp((s) => s.version);
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
        <label className="btnLike"><Upload /> Import settings<input type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importBundle(f); }} /></label>
      </div>
      {msg && <p>{msg}</p>}
      <div className="setting">
        <div><b>Reset all data</b><span>Erase favorites, teams, schedule, picks, playlists and settings on this device and start fresh.</span></div>
        <button className="ghost danger" onClick={() => { if (confirm('Erase all Dial TV data on this device?')) void resetAllData(); }}>Reset</button>
      </div>
      <p className="muted small">Schema v{version}</p>
    </section>
  );
}
