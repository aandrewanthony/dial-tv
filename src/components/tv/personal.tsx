import { useMemo } from 'react';
import type { Channel, Program } from '../../types';
import { listings, slotAt, type PersonalChannel, type Durations } from '../../lib/personalSchedule';
import { PERSONAL_GROUP, PERSONAL_PREFIX, isPersonalId, personalIdOf, useTv } from '../../store/tv';
import { programsInRange } from '../../store/app';
import { ChannelMark } from '../ui';

const chCache = new WeakMap<PersonalChannel, Channel>();

/** A personal channel as a Channel object (for lists, guide rows, pickers). Never played directly. */
export function asChannel(p: PersonalChannel): Channel {
  let c = chCache.get(p);
  if (!c) {
    const words = p.name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    c = {
      id: PERSONAL_PREFIX + p.id,
      number: p.number,
      name: p.name,
      group: PERSONAL_GROUP,
      mark: (words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? 'MY').slice(0, 2)).toUpperCase(),
      url: `personal:${p.id}`,
      sourceId: 'personal',
    };
    chCache.set(p, c);
  }
  return c;
}

/** Personal channels as Channel objects, sorted by number. */
export function usePersonalChannels() {
  const defs = useTv((s) => s.personal);
  return useMemo(() => [...defs].sort((a, b) => a.number - b.number).map(asChannel), [defs]);
}

export function findPersonal(defs: PersonalChannel[], channelId?: string) {
  return channelId && isPersonalId(channelId) ? defs.find((p) => p.id === personalIdOf(channelId)) : undefined;
}

/** Guide listings of a personal channel as Program objects. */
export function personalPrograms(p: PersonalChannel, known: Durations, from: number, to: number): Program[] {
  const channelId = PERSONAL_PREFIX + p.id;
  return listings(p, known, from, to).map((s) => ({
    id: `${channelId}@${s.start}`,
    channelId,
    title: s.item.title,
    subtitle: s.item.subtitle,
    start: s.start,
    end: s.end,
    category: s.item.kind === 'movie' ? 'Movie' : 'Series',
  }));
}

/** Programs of any channel (EPG or personal) overlapping [from, to). */
export function programsFor(
  channelId: string,
  from: number,
  to: number,
  ctx: { programs: Program[]; personal: PersonalChannel[]; durations: Durations },
): Program[] {
  if (isPersonalId(channelId)) {
    const p = findPersonal(ctx.personal, channelId);
    return p ? personalPrograms(p, ctx.durations, from, to) : [];
  }
  return programsInRange(ctx.programs, channelId, from, to);
}

/** Now/next for any channel. */
export function nowNext(channelId: string, at: number, ctx: { programs: Program[]; personal: PersonalChannel[]; durations: Durations }) {
  if (isPersonalId(channelId)) {
    const p = findPersonal(ctx.personal, channelId);
    if (!p) return {};
    const [now, next] = personalPrograms(p, ctx.durations, at, at + 1);
    const nxt = next ?? (now ? personalPrograms(p, ctx.durations, now.end, now.end + 1)[0] : undefined);
    return { now, next: nxt };
  }
  const list = programsInRange(ctx.programs, channelId, at, at + 12 * 3600_000);
  const now = list.find((x) => x.start <= at && x.end > at);
  const next = list.find((x) => x.start >= (now?.end ?? at));
  return { now, next };
}

export { slotAt };

/** Channel mark that shows a personal channel's color. */
export function TvMark({ channel, size = 40 }: { channel: Channel; size?: number }) {
  const color = useTv((s) => (isPersonalId(channel.id) ? s.personal.find((p) => p.id === personalIdOf(channel.id))?.color : undefined));
  if (!color) return <ChannelMark channel={channel} size={size} />;
  return <span className="chMark tvPMark" style={{ width: size, height: size, background: color }}>{channel.mark}</span>;
}
