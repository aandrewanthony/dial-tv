import { memo, useEffect, useMemo, useState } from 'react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import {
  AlertTriangle, Download, Eye, EyeOff, GripVertical, Heart, Link2, Loader2, Lock, RefreshCw, Trash2, Unlock, Upload,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { DEFAULT_PLAYBACK, migrate, orderedChannels, pickPersisted, resetAllData, sha256, useApp, type PlaybackSettings, type Settings } from '../store/app';
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
import { desktop, isDesktop, type DecoderInfo } from '../lib/net';
import { BUFFER_HELP, bufferProfile, machineInfo, resolveComputer } from '../player/tuning';
import { setChannelPrefs, useChannelPrefs } from '../store/channelPrefs';
import type { OrgChannel } from '../lib/channelOrg';
import { isFavorite, toggleFavorite, useOrganized } from '../components/channels/useOrganized';
import { GroupManager } from '../components/channels/GroupManager';
import { GroupPicker } from '../components/channels/GroupPicker';
import { GuideDataPanel, GuideMappingPanel } from './GuideSettings';
import { RemoteSettings } from './RemoteSettings';

type Tab = 'sources' | 'channels' | 'mapping' | 'playback' | 'sports' | 'parental' | 'remote' | 'appearance' | 'backup';
const TABS: [Tab, string][] = [
  ['sources', 'Sources'], ['channels', 'Channels'], ['mapping', 'Mapping'], ['playback', 'Playback'], ['sports', 'Sports & alerts'],
  ['parental', 'Parental'], ['remote', 'Remote'], ['appearance', 'Appearance'], ['backup', 'Backup'],
];
/** Remote Control needs the desktop shell (it runs a LAN server). */
const tabsHere = (): [Tab, string][] => (isDesktop() ? TABS : TABS.filter(([t]) => t !== 'remote'));

const reload = () => setTimeout(() => void useApp.getState().loadSources(), 0);
const setSettings = (p: Partial<Settings>) => useApp.getState().update((st) => ({ settings: { ...st.settings, ...p } }));
const useOrdered = (includeHidden = false) => {
  const { channels, channelOrder, hidden } = useApp(useShallow((s) => ({ channels: s.channels, channelOrder: s.channelOrder, hidden: s.hidden })));
  return useMemo(() => orderedChannels({ channels, channelOrder, hidden }, includeHidden), [channels, channelOrder, hidden, includeHidden]);
};

export default function SettingsPage() {
  const { param } = useRoute();
  const tabs = tabsHere();
  const tab = (tabs.some(([t]) => t === param) ? param : 'sources') as Tab;
  return (
    <div className="settingsPage">
      <div className="chips tabs">
        {tabs.map(([t, l]) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => navigate('settings', t)}>{l}</button>)}
      </div>
      {tab === 'sources' && <Sources />}
      {tab === 'channels' && <Channels />}
      {tab === 'mapping' && <Mapping />}
      {tab === 'playback' && <Playback />}
      {tab === 'sports' && <SportsSettings />}
      {tab === 'parental' && <Parental />}
      {tab === 'remote' && <RemoteSettings />}
      {tab === 'appearance' && <Appearance />}
      {tab === 'backup' && <Backup />}
    </div>
  );
}

function Sources() {
  const playlists = useApp((s) => s.playlists);
  const loading = useApp((s) => s.loadingSources);
  const update = useApp((s) => s.update);

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

      <GuideDataPanel />
    </div>
  );
}

const SortRow = memo(function SortRow({ c, guard }: { c: OrgChannel; guard: (fn: () => void) => void }) {
  const hidden = useApp((s) => s.hidden.includes(c.id));
  const groupHidden = useChannelPrefs((s) => s.hiddenGroups.includes(c.groupKey));
  const locked = useApp((s) => s.settings.locked.includes(c.id));
  const fav = useApp((s) => isFavorite(s.favorites, c));
  const update = useApp((s) => s.update);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: c.id });
  const toggleHidden = () => update((st) => ({ hidden: hidden ? st.hidden.filter((x) => x !== c.id) : [...st.hidden, c.id] }));
  // Changing a lock needs the PIN (when one is set).
  const toggleLock = () => guard(() => update((st) => ({
    settings: { ...st.settings, locked: st.settings.locked.includes(c.id) ? st.settings.locked.filter((x) => x !== c.id) : [...st.settings.locked, c.id] },
  })));
  return (
    <div ref={setNodeRef} className={`chRow ${hidden || groupHidden ? 'hiddenCh' : ''}`} style={{ transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined, transition }}>
      <span className="grip" {...attributes} {...listeners}><GripVertical /></span>
      <ChannelMark channel={c} size={30} />
      <span className="num">{c.number}</span>
      <b title={c.variants.map((v) => v.rawName).join('\n')}>{c.displayName}{c.country && <span className="ccBadge">{c.country}</span>}</b>
      {c.variants.length > 1 && <span className="qBadge">{c.qualityLabel}<small>×{c.variants.length}</small></span>}
      <small>{c.group}{groupHidden ? ' (hidden)' : ''}</small>
      <button className={`icon ${fav ? 'on' : ''}`} title="Favorite" onClick={() => toggleFavorite(c)}><Heart fill={fav ? 'currentColor' : 'none'} /></button>
      <button className="icon" title={hidden ? 'Show' : 'Hide'} onClick={toggleHidden}>{hidden ? <EyeOff /> : <Eye />}</button>
      <button className={`icon ${locked ? 'on' : ''}`} title={locked ? 'Unlock' : 'Lock (needs PIN)'} onClick={toggleLock}>{locked ? <Lock /> : <Unlock />}</button>
    </div>
  );
});

function Channels() {
  const [q, setQ] = useState('');
  const [grp, setGrp] = useState('*');
  const [picker, setPicker] = useState(false);
  const [guard, pinModal] = usePinGuard();
  const { full, groups, org } = useOrganized();
  const merge = useChannelPrefs((s) => s.mergeDuplicates);
  const renumber = useChannelPrefs((s) => s.renumber);
  const inGroup = useMemo(() => (grp === '*' ? full : full.filter((c) => c.groupKey === grp)), [full, grp]);
  const shown = useMemo(() => {
    const n = q.toLowerCase();
    return inGroup.filter((c) => !n || `${c.name} ${c.rawName} ${c.group} ${c.number}`.toLowerCase().includes(n)).slice(0, 300);
  }, [inGroup, q]);
  const ids = useMemo(() => shown.map((c) => c.id), [shown]);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const all_ = full.map((c) => c.id);
    const from = all_.indexOf(String(e.active.id));
    const to = all_.indexOf(String(e.over.id));
    useApp.setState({ channelOrder: arrayMove(all_, from, to) });
  };
  return (
    <div className="settingsCol">
      <section className="panel">
        <h2>Organize</h2>
        <div className="setting">
          <div><b>Merge duplicates</b><span>One channel for “ESPN”, “ESPN FHD”, “ESPN 4K”, “ESPN (Backup)”… The best quality for your Playback settings plays first; the others are backups and can be picked in the channel’s Quality menu.{org.rawCount > 0 && ` ${org.rawCount.toLocaleString()} playlist entries → ${org.all.length.toLocaleString()} channels.`}</span></div>
          <Toggle label="Merge duplicates" on={merge} onChange={(v) => setChannelPrefs({ mergeDuplicates: v })} />
        </div>
        <div className="setting">
          <div><b>Renumber channels</b><span>Number your visible channels 1, 2, 3… in your order (typing a number tunes these).</span></div>
          <Toggle label="Renumber channels" on={renumber} onChange={(v) => setChannelPrefs({ renumber: v })} />
        </div>
      </section>
      <GroupManager onChoose={() => setPicker(true)} />
      <section className="panel">
        <div className="panelHead">
          <h2>Channels · {inGroup.length.toLocaleString()}</h2>
          <div className="row">
            <select className="field small" aria-label="Group" value={grp} onChange={(e) => setGrp(e.target.value)}>
              <option value="*">All groups</option>
              {groups.map((g) => <option key={g.key} value={g.key}>{g.label}{g.hidden ? ' (hidden)' : ''} · {g.count}</option>)}
            </select>
            <input className="field small" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="ghost" onClick={() => useApp.setState({ channelOrder: [] })}>Reset order</button>
          </div>
        </div>
        <p className="muted small">Drag to reorder inside a group, hide channels you never watch, lock channels behind the parental PIN.{inGroup.length > 300 && ' Showing the first 300 — filter or pick a group to find others.'}</p>
        <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div className="chList">{shown.map((c) => <SortRow key={c.id} c={c} guard={guard} />)}</div>
          </SortableContext>
        </DndContext>
        {pinModal}
      </section>
      {picker && <GroupPicker onClose={() => setPicker(false)} />}
    </div>
  );
}

function Mapping() {
  const channels = useOrdered();
  const games = useApp((s) => s.games);
  const overrides = useApp((s) => s.networkOverrides);
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
  const chOptions = useMemo(() => channels.map((c) => ({ id: c.id, label: `${c.number} · ${c.name}` })), [channels]);

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
      <GuideMappingPanel />
    </div>
  );
}

function Choice<T extends string>({ k, value, options, onPick, disabled }: { k: string; value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="chips">
      {options.map(([v, l]) => <button key={v} data-pb={`${k}:${v}`} disabled={disabled} className={value === v ? 'on' : ''} onClick={() => onPick(v)}>{l}</button>)}
    </div>
  );
}

const HW_NAMES: Record<string, string> = { h264_nvenc: 'NVIDIA NVENC', h264_qsv: 'Intel Quick Sync', h264_amf: 'AMD AMF', h264_videotoolbox: 'Apple VideoToolbox' };

function Playback() {
  const decoder = useApp((s) => s.settings.decoder);
  const n = useApp((s) => s.settings.decoderChannels.length);
  const pb = useApp((s) => s.settings.playback ?? DEFAULT_PLAYBACK);
  const setPb = (p: Partial<PlaybackSettings>) => useApp.getState().update((st) => ({ settings: { ...st.settings, playback: { ...DEFAULT_PLAYBACK, ...st.settings.playback, ...p } } }));
  const [dec, setDec] = useState<DecoderInfo | null>(null);
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ask = () => desktop()?.decoder?.info().then((i) => {
      if (!live) return;
      setDec(i);
      if (i?.available && !i.hwChecked) t = setTimeout(ask, 1500); // graphics card test still running
    }, () => {});
    ask();
    return () => { live = false; clearTimeout(t); };
  }, []);
  const m = machineInfo(dec?.hwEncoder ?? null);
  const level = resolveComputer(pb.computer, m);
  const prof = bufferProfile(pb);
  const enc = !isDesktop() ? 'desktop app only' : !dec ? 'checking…' : !dec.available ? 'decoder not available' : !dec.hwChecked ? 'testing graphics card…' : dec.hwEncoder ? (HW_NAMES[dec.hwEncoder] ?? dec.hwEncoder) : 'none found (uses the CPU)';
  return (
    <div className="settingsCol">
      <section className="panel pbPanel">
        <h2>Playback</h2>
        <p className="muted">Changes apply right away: the channel that is playing re-tunes (movies continue where they were).</p>
        <div className="setting">
          <div><b>Buffer</b><span>{BUFFER_HELP[prof]}</span></div>
          <Choice k="buffer" value={pb.buffer} onPick={(v) => setPb({ buffer: v })} options={[['auto', 'Auto'], ['low-latency', 'Low latency'], ['balanced', 'Balanced'], ['smooth', 'Smooth'], ['max', 'Max']] as const} />
        </div>
        <div className="setting">
          <div><b>This computer</b><span>How hard the built-in decoder may work. Low converts to 720p with the fastest settings; High gives the best picture. Auto chose <b>{level}</b> for {m.threads} CPU threads{m.memoryGb ? ` and ${m.memoryGb}+ GB memory` : ''}.</span></div>
          <Choice k="computer" value={pb.computer} onPick={(v) => setPb({ computer: v })} options={[['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] as const} />
        </div>
        <div className="setting">
          <div><b>Graphics card encoding</b><span>Lets the decoder use the graphics card (NVIDIA, Intel Quick Sync, AMD, Apple) to save CPU. Auto uses it on slower computers and in Multiview. Found: <b>{enc}</b>.</span></div>
          <Choice k="hwAccel" value={pb.hwAccel} disabled={!isDesktop()} onPick={(v) => setPb({ hwAccel: v })} options={[['auto', 'Auto'], ['on', 'On'], ['off', 'Off']] as const} />
        </div>
        <div className="setting">
          <div><b>Max resolution</b><span>Limit the picture size to save data and CPU on slow connections or computers. Auto picks the best the connection allows.</span></div>
          <Choice k="maxResolution" value={pb.maxResolution} onPick={(v) => setPb({ maxResolution: v })} options={[['auto', 'Auto'], ['2160', '4K'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']] as const} />
        </div>
        <div className="setting">
          <div><b>Start quality</b><span>For channels with several qualities: Auto measures your connection, Highest looks best from the first second, Lowest starts fastest.</span></div>
          <Choice k="startQuality" value={pb.startQuality} onPick={(v) => setPb({ startQuality: v })} options={[['auto', 'Auto'], ['highest', 'Highest'], ['lowest', 'Lowest']] as const} />
        </div>
        <div className="setting">
          <div><b>Deinterlace</b><span>Removes the comb lines of broadcast TV (1080i) in the built-in decoder. Auto does it only when the channel is interlaced.</span></div>
          <Choice k="deinterlace" value={pb.deinterlace} onPick={(v) => setPb({ deinterlace: v })} options={[['auto', 'Auto'], ['on', 'Always'], ['off', 'Off']] as const} />
        </div>
        <div className="setting">
          <div><b>Resume movies &amp; episodes</b><span>Continue where you stopped watching.</span></div>
          <Toggle label="Resume movies and episodes" on={pb.resumeVod} onChange={(v) => setPb({ resumeVod: v })} />
        </div>
      </section>
      <section className="panel">
        <h2>Built-in decoder</h2>
        <div className="setting">
          <div>
            <b>Built-in decoder</b>
            <span>{isDesktop()
              ? 'Converts channels the player can\x27t play directly (MPEG-2 video, AC-3 / Dolby, E-AC-3, MP2 audio, and HEVC on PCs without HEVC support). Auto checks each channel and switches only when needed.'
              : 'Available in the Windows and Mac apps. The web version can\x27t convert video formats.'}</span>
          </div>
          <Choice k="decoder" value={decoder} disabled={!isDesktop()} onPick={(v) => setSettings({ decoder: v })} options={[['auto', 'Auto'], ['always', 'Always'], ['off', 'Off']] as const} />
        </div>
        <div className="setting">
          <div><b>Channels using the decoder</b><span>{n ? `${n} channel${n > 1 ? 's' : ''} start with the decoder because they needed it before.` : 'None yet.'}</span></div>
          <button className="ghost" disabled={!n} onClick={() => setSettings({ decoderChannels: [] })}>Reset</button>
        </div>
        <p className="muted small">This computer: {m.threads} CPU threads{m.memoryGb ? ` · ${m.memoryGb}+ GB memory` : ''} · graphics card encoder: {enc}</p>
      </section>
    </div>
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
      <p className="muted">Export favorites, schedule, rules, bets, mappings and source list to a JSON file — use it to move settings between the web app and desktop. Playlist URLs may contain your provider login, so keep the file private. Imported local playlist files must be re-added.</p>
      <div className="row">
        <button className="primary" onClick={exportBundle}><Download /> Export settings</button>
        <label className="btnLike"><Upload /> Import settings<input type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importBundle(f); }} /></label>
      </div>
      {msg && <p>{msg}</p>}
      <div className="setting">
        <div><b>Reset all data</b><span>Erase favorites, teams, schedule, bets, playlists and settings on this device and start fresh.</span></div>
        <button className="ghost danger" onClick={() => { if (confirm('Erase all Dial TV data on this device?')) void resetAllData(); }}>Reset</button>
      </div>
      <p className="muted small">Schema v{version}</p>
    </section>
  );
}
