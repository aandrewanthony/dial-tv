import { CircleDot, Square, X } from 'lucide-react';
import { useApp } from '../../store/app';
import { isPersonalId } from '../../store/tv';
import { dvrBridge, jobForNow, jobForProgram, recordingFor, recordingOn, useDvr, type DvrJob } from '../../lib/dvr';
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
