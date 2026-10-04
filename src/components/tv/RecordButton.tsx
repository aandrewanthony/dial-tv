import { useState } from 'react';
import { CircleDot, Repeat, Square, X } from 'lucide-react';
import { useApp } from '../../store/app';
import { isPersonalId } from '../../store/tv';
import { dvrBridge, jobForNow, jobForProgram, recordingFor, recordingOn, useDvr, type DvrJob } from '../../lib/dvr';
import { addSeriesRule, removeSeriesRule, seriesRuleFor, useRecRules } from '../../lib/dvrRules';
import type { Channel, Program } from '../../types';

async function schedule(job: DvrJob) {
  const b = dvrBridge();
  if (!b) return;
  const { toast } = useApp.getState();
  const r = await b.schedule(job);
  if (r.error) return toast({ kind: 'error', title: r.error, ttl: 4000 });
  const max = useDvr.getState().settings.maxConcurrent;
  toast({
    kind: r.conflicts ? 'error' : 'info',
    title: r.conflicts ? `Recording set, but more than ${max} overlap` : job.start <= Date.now() + 1000 ? `Recording ${job.title}` : `Will record ${job.title}`,
    body: r.conflicts ? 'The extra one waits for a free slot. Settings are on the Recordings page.' : undefined,
    ttl: 3500,
  });
}

/** Can this channel be recorded? Desktop only, real playlist channels only (not My Channels / movies). */
export function canRecord(c?: Channel) {
  return !!c && !!dvrBridge() && useDvr.getState().available && !isPersonalId(c.id) && (!c.kind || c.kind === 'live');
}

/**
 * Record button. With `program`: records that guide show (with padding). Without: records the channel
 * now, until the current show ends (`now`) or for an hour. Turns into Stop / Cancel when set.
 */
export function RecordButton({ channel, program, now, className = '' }: { channel?: Channel; program?: Program; now?: Program; className?: string }) {
  const recs = useDvr((s) => s.recordings);
  const settings = useDvr((s) => s.settings);
  const available = useDvr((s) => s.available);
  if (!channel || !available || !canRecord(channel)) return null;
  if (program && program.end <= Date.now()) return null;
  const rec = program ? recordingFor(recs, channel.id, program) : recordingOn(recs, channel.id);
  if (rec) {
    const on = rec.status === 'recording';
    return (
      <button className={`recBtn ${on ? 'on' : 'set'} ${className}`} onClick={() => void dvrBridge()?.stop(rec.id)} title={on ? 'Stop recording (keeps what was recorded)' : 'Cancel this recording'}>
        {on ? <><Square /> Stop recording</> : <><X /> Cancel recording</>}
      </button>
    );
  }
  return (
    <button
      className={`recBtn ${className}`}
      onClick={() => void schedule(program ? jobForProgram(channel, program, settings) : jobForNow(channel, now, settings))}
      title={program ? `Record (${settings.padBefore} min early, ${settings.padAfter} min late)` : now ? 'Record until this show ends' : 'Record for an hour'}
    >
      <CircleDot /> Record
    </button>
  );
}

/**
 * "Record series" for a guide programme: opens a small form (this channel only / any channel,
 * new episodes only) and saves a series rule (src/lib/dvrRules.ts). With a rule already set for
 * this title, it becomes "Series recording on · stop".
 */
export function RecordSeriesButton({ channel, program }: { channel?: Channel; program: Program }) {
  const available = useDvr((s) => s.available);
  const rules = useRecRules((s) => s.series);
  const [open, setOpen] = useState(false);
  const [thisChannel, setThisChannel] = useState(true);
  const [newOnly, setNewOnly] = useState(false);
  if (!channel || !available || !canRecord(channel)) return null;
  const rule = seriesRuleFor(rules, program.title, channel.id);
  if (rule) {
    return (
      <button className="recBtn set" onClick={() => removeSeriesRule(rule.id)} title="Stop recording this series (recordings already made are kept)">
        <Repeat /> Series recording on{rule.channelId ? '' : ' (any channel)'} · stop
      </button>
    );
  }
  if (!open) return <button className="recBtn" onClick={() => setOpen(true)}><Repeat /> Record series</button>;
  return (
    <div className="seriesForm">
      <b>Record every “{program.title}”</b>
      <div className="chips">
        <button className={thisChannel ? 'on' : ''} aria-pressed={thisChannel} onClick={() => setThisChannel(true)}>This channel only</button>
        <button className={!thisChannel ? 'on' : ''} aria-pressed={!thisChannel} onClick={() => setThisChannel(false)}>Any channel</button>
      </div>
      <label className="seriesCheck"><input type="checkbox" checked={newOnly} onChange={(e) => setNewOnly(e.target.checked)} /> New episodes only</label>
      <div className="row">
        <button className="primary" onClick={() => { setOpen(false); void addSeriesRule(program, channel, { thisChannel, newOnly }); }}><Repeat /> Record series</button>
        <button className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
