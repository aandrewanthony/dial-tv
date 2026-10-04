import { useEffect, useMemo, useState } from 'react';
import { CircleDot, FolderOpen, Play, Repeat, Square, Trash2, X } from 'lucide-react';
import Player from '../player/Player';
import { useApp } from '../store/app';
import { resumeAt, saveProgress } from '../store/tv';
import { fmtDay, fmtTime, Modal, Toggle, useNow } from '../components/ui';
import { dvrBridge, fmtBytes, initDvr, useDvr, type Recording } from '../lib/dvr';
import { navigate } from '../app/router';
import { removeSeriesRule, setSeriesEnabled, setTeamOn, setTeamsOn, teamName, useRecRules } from '../lib/dvrRules';
import { leagueLabel } from '../lib/sports';
import type { Channel, League } from '../types';

const MIN = 60_000;
const dur = (ms: number) => {
  const m = Math.max(1, Math.round(ms / MIN));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${m} min`;
};
const when = (r: Recording) => `${fmtDay(r.start)} · ${fmtTime(r.start)} – ${fmtTime(r.end)}`;
/** "Auto: Lions" tag on recordings made by a rule. */
const AutoTag = ({ r }: { r: Recording }) => (r.rule ? <span className="recAuto">Auto: {r.rule.label}</span> : null);

/** Recording rules: auto-record my teams + series rules. */
function RulesPanel() {
  const { teamsOn, teamsOff, series } = useRecRules();
  const favTeams = useApp((s) => s.favTeams);
  const games = useApp((s) => s.games);
  return (
    <section className="panel recRules">
      <div className="recRuleRow head">
        <div className="recInfo"><b>Auto-record my teams</b><small>Every game of your teams in the next week, on the channel it’s on in your playlist. Runs long? The recording keeps going (up to 90 min).</small></div>
        <Toggle on={teamsOn} onChange={setTeamsOn} label="Auto-record my teams" />
      </div>
      {teamsOn && (favTeams.length ? (
        <div className="recTeams">
          {favTeams.map((k) => (
            <label key={k} className="recTeam">
              <span><b>{teamName(k, games)}</b> <small className="muted">{leagueLabel(k.split(':')[0] as League)}</small></span>
              <Toggle on={!teamsOff.includes(k)} onChange={(on) => setTeamOn(k, on)} label={`Auto-record ${teamName(k, games)}`} />
            </label>
          ))}
        </div>
      ) : <p className="muted small">No favorite teams yet. <button className="link" onClick={() => navigate('teams')}>Pick your teams</button></p>)}
      <h3 className="recH">Series</h3>
      {series.length ? (
        <div className="recList">
          {series.map((r) => (
            <div key={r.id} className={`recRow${r.enabled ? '' : ' off'}`}>
              <Repeat className="recIcon" />
              <div className="recInfo"><b>{r.title}</b><small>{r.channelName ?? 'Any channel'}{r.newOnly ? ' · New episodes only' : ''}</small></div>
              <Toggle on={r.enabled} onChange={(on) => setSeriesEnabled(r.id, on)} label={`Record ${r.title}`} />
              <button className="icon" onClick={() => removeSeriesRule(r.id)} title="Delete rule" aria-label={`Delete rule ${r.title}`}><Trash2 /></button>
            </div>
          ))}
        </div>
      ) : <p className="muted small">Open a show in the Guide and press <b>Record series</b> to record every airing.</p>}
    </section>
  );
}

/** Recordings (desktop DVR): recording now, upcoming, recorded, and what didn't record. */
export default function RecordingsPage() {
  const { ready, available, recordings, settings } = useDvr();
  const now = useNow(15_000);
  const [playing, setPlaying] = useState<{ rec: Recording; url: string }>();
  const [confirmDel, setConfirmDel] = useState<Recording>();
  // Xtream accounts report how many streams they allow at once.
  const providerMax = useApp((s) => s.playlists.reduce<number | undefined>((m, p) => (p.enabled !== false && p.maxConnections ? Math.min(m ?? Infinity, p.maxConnections) : m), undefined));
  useEffect(() => initDvr(), []);

  const groups = useMemo(() => {
    const by = (s: Recording['status'][]) => recordings.filter((r) => s.includes(r.status));
    return {
      now: by(['recording', 'processing']),
      upcoming: by(['scheduled']).sort((a, b) => a.start - b.start),
      done: by(['done']).sort((a, b) => (b.startedAt ?? b.start) - (a.startedAt ?? a.start)),
      failed: by(['failed', 'missed', 'cancelled']).sort((a, b) => b.start - a.start).slice(0, 20),
    };
  }, [recordings]);

  // More recordings overlapping than allowed at once: the later ones wait.
  const conflicts = useMemo(() => {
    const active = recordings.filter((r) => r.status === 'scheduled' || r.status === 'recording');
    return new Set(active.filter((r) => active.filter((o) => o.start < r.end && o.end > r.start && o.start <= r.start).length > settings.maxConcurrent).map((r) => r.id));
  }, [recordings, settings.maxConcurrent]);

  const b = dvrBridge();
  if (!b) {
    return <div className="empty"><CircleDot /><b>Recording needs the desktop app</b><p>Dial TV for Windows and Mac can record shows to your computer.</p></div>;
  }
  if (ready && !available) {
    return <div className="empty"><CircleDot /><b>Recording isn’t available</b><p>The built-in decoder (ffmpeg) wasn’t found in this install. Reinstalling Dial TV fixes it.</p></div>;
  }

  const play = async (r: Recording) => {
    const url = await b.playUrl(r.id);
    if (url) setPlaying({ rec: r, url });
    else useApp.getState().toast({ kind: 'error', title: 'Recording file not found', body: 'It may have been moved or deleted.', ttl: 4000 });
  };

  const pseudo: Channel | undefined = playing && {
    id: `rec:${playing.rec.id}`, number: 0, name: playing.rec.title, group: 'Recordings', mark: 'REC', url: playing.url, sourceId: 'dvr', kind: 'movie',
  };

  return (
    <div className="recPage">
      {playing && pseudo && (
        <section className="recPlayer">
          <div className="recPlayerHead">
            <div><b>{playing.rec.title}</b>{playing.rec.subtitle && <span className="muted"> · {playing.rec.subtitle}</span>}<small className="muted">{playing.rec.channelName} · {fmtDay(playing.rec.start)}</small></div>
            <button className="icon" onClick={() => setPlaying(undefined)} aria-label="Close player"><X /></button>
          </div>
          <div className="screen">
            <Player key={pseudo.id} channel={pseudo} vod startAt={resumeAt(pseudo.id) ?? 0} onProgress={(pos, d) => saveProgress(pseudo.id, pos, d)} />
          </div>
        </section>
      )}

      <section className="panel recSettings">
        <div className="recFolder">
          <span className="sectionTitle">SAVED TO</span>
          <code title={settings.folder}>{settings.folder}</code>
          <button className="ghost" onClick={() => void b.reveal(null)}><FolderOpen /> Open</button>
          <button className="ghost" onClick={() => void b.chooseFolder()}>Change</button>
        </div>
        <div className="recOpts">
          <label><span>At once</span>
            <div className="chips">{[1, 2, 3, 4].map((n) => <button key={n} className={settings.maxConcurrent === n ? 'on' : ''} aria-pressed={settings.maxConcurrent === n} onClick={() => void b.settings({ maxConcurrent: n })}>{n}</button>)}</div>
          </label>
          <label><span>Start early</span>
            <select className="field small" value={settings.padBefore} onChange={(e) => void b.settings({ padBefore: +e.target.value })}>{[0, 1, 2, 5].map((n) => <option key={n} value={n}>{n} min</option>)}</select>
          </label>
          <label><span>End late</span>
            <select className="field small" value={settings.padAfter} onChange={(e) => void b.settings({ padAfter: +e.target.value })}>{[0, 3, 5, 10, 15, 30].map((n) => <option key={n} value={n}>{n} min</option>)}</select>
          </label>
        </div>
        <p className="muted small">Each recording is its own connection to your provider, and watching counts too. {providerMax ? <>Your provider allows <b>{providerMax}</b> at once{settings.maxConcurrent >= providerMax ? ', so recording while you watch may cut one off' : ''}.</> : 'Many providers allow only one or two at a time.'}</p>
      </section>

      <RulesPanel />

      {!recordings.length && ready && (
        <div className="empty"><CircleDot /><b>No recordings yet</b><p>Press <b>Record</b> under the player on Live TV, or on any show in the Guide.</p>
          <button className="primary" onClick={() => navigate('guide')}>Open the Guide</button></div>
      )}

      {groups.now.length > 0 && (
        <section><h3 className="recH">Recording now</h3>
          <div className="recList">
            {groups.now.map((r) => {
              const pct = Math.min(100, ((now - r.start) / (r.end - r.start)) * 100);
              return (
                <div key={r.id} className="recRow live">
                  <span className="recDot" aria-hidden />
                  <div className="recInfo"><b>{r.title}</b><AutoTag r={r} /><small>{r.channelName} · {when(r)}</small>
                    {r.status === 'recording' ? <div className="bar"><i style={{ width: `${pct}%` }} /></div> : <small className="muted">Finishing the file…</small>}
                    {r.error && <small className="warnTxt">{r.error}</small>}
                  </div>
                  {r.status === 'recording' && <button onClick={() => void b.stop(r.id)}><Square /> Stop</button>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {groups.upcoming.length > 0 && (
        <section><h3 className="recH">Upcoming</h3>
          <div className="recList">
            {groups.upcoming.map((r) => (
              <div key={r.id} className="recRow">
                <CircleDot className="recIcon" />
                <div className="recInfo"><b>{r.title}</b><AutoTag r={r} /><small>{r.channelName} · {when(r)} · {dur(r.end - r.start)}</small>
                  {(conflicts.has(r.id) || r.error) && <small className="warnTxt">{r.error ?? `Overlaps more than ${settings.maxConcurrent} at once: it waits for a free slot`}</small>}
                </div>
                <button className="ghost" onClick={() => void b.stop(r.id)}><X /> Cancel</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {groups.done.length > 0 && (
        <section><h3 className="recH">Recorded <small>{groups.done.length} · {fmtBytes(groups.done.reduce((n, r) => n + (r.bytes ?? 0), 0))}</small></h3>
          <div className="recList">
            {groups.done.map((r) => (
              <div key={r.id} className="recRow">
                <button className="recPlay" onClick={() => void play(r)} aria-label={`Play ${r.title}`}><Play /></button>
                <div className="recInfo"><b>{r.title}</b>{r.subtitle && <span className="muted"> {r.subtitle}</span>}<AutoTag r={r} />
                  <small>{r.channelName} · {fmtDay(r.startedAt ?? r.start)} {fmtTime(r.startedAt ?? r.start)} · {dur((r.endedAt ?? r.end) - (r.startedAt ?? r.start))}{r.bytes ? ` · ${fmtBytes(r.bytes)}` : ''}</small>
                  {(r.partial || r.error) && <small className="warnTxt">{r.error ?? 'Partial recording'}</small>}
                </div>
                <button className="icon" onClick={() => void b.reveal(r.id)} title="Show in folder" aria-label="Show in folder"><FolderOpen /></button>
                <button className="icon" onClick={() => setConfirmDel(r)} title="Delete" aria-label={`Delete ${r.title}`}><Trash2 /></button>
              </div>
            ))}
          </div>
        </section>
      )}

      {groups.failed.length > 0 && (
        <section><h3 className="recH">Didn’t record</h3>
          <div className="recList dimList">
            {groups.failed.map((r) => (
              <div key={r.id} className="recRow">
                <X className="recIcon" />
                <div className="recInfo"><b>{r.title}</b><small>{r.channelName} · {when(r)} · {r.status === 'cancelled' ? 'Cancelled' : r.error ?? r.status}</small></div>
                <button className="icon" onClick={() => void b.remove(r.id)} title="Remove from list" aria-label="Remove from list"><X /></button>
              </div>
            ))}
          </div>
        </section>
      )}

      {confirmDel && (
        <Modal title="Delete recording?" onClose={() => setConfirmDel(undefined)}>
          <p><b>{confirmDel.title}</b> moves to the {navigator.platform.startsWith('Mac') ? 'Trash' : 'Recycle Bin'}, so you can still get it back.</p>
          <div className="row">
            <button className="primary" autoFocus onClick={() => { const r = confirmDel; setConfirmDel(undefined); if (playing?.rec.id === r.id) setPlaying(undefined); void b.remove(r.id); }}><Trash2 /> Delete</button>
            <button className="ghost" onClick={() => setConfirmDel(undefined)}>Keep</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
