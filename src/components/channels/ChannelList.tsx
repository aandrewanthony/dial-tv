import { lockedSet, useApp } from '../../store/app';
import { memo, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Lock, MoreVertical, Star } from 'lucide-react';
import type { Channel, Program } from '../../types';
import { TvMark, nowNext } from '../tv/personal';
import { ChannelMenu } from './ChannelMenu';
import { isFavorite, isOrg, toggleFavorite } from './useOrganized';

const ROW_H = 58;

type Ctx = Parameters<typeof nowNext>[2];

interface Props {
  rows: Channel[];
  currentId?: string;
  onTune: (id: string) => void;
  now: number;
  ctx: Ctx;
  favorites: string[];
  locked: string[];
  empty?: string;
}

/**
 * Compact virtualized channel list (number, logo, clean name, now playing + progress, quality,
 * favorite star, menu). Rows are direct children of `.channels` between two spacers, so only
 * the visible rows are in the DOM even for 30k-channel playlists.
 */
export function ChannelList({ rows, currentId, onTune, now, ctx, favorites, locked, empty = 'No channels match.' }: Props) {
  // A lock saved on a merged duplicate also locks the merged channel.
  const lockedIds = useApp((s) => (s.settings.locked === locked ? lockedSet(s) : new Set(locked)));
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ c: Channel; x: number; y: number } | null>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    initialRect: { width: 600, height: 640 },
  });
  // Keep the tuned channel in view when the list changes (new group, search).
  const rowsRef = useRef(rows);
  useEffect(() => {
    const i = rows.findIndex((c) => c.id === currentId);
    if (i >= 0) virt.scrollToIndex(i, { align: rowsRef.current === rows ? 'auto' : 'center' });
    else if (rowsRef.current !== rows) virt.scrollToOffset(0);
    rowsRef.current = rows;
  }, [rows, currentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = virt.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = Math.max(0, virt.getTotalSize() - (items[items.length - 1]?.end ?? 0));
  return (
    <div className="channels lineupList" ref={ref} aria-label="Channels">
      <div className="lineupPad" style={{ height: padTop }} aria-hidden />
      {items.map((it) => {
        const c = rows[it.index];
        return (
          <Row
            key={c.id}
            c={c}
            selected={c.id === currentId}
            np={nowNext(c.id, now, ctx).now}
            now={now}
            fav={isFavorite(favorites, c)}
            locked={lockedIds.has(c.id)}
            onTune={onTune}
            onMenu={(x, y) => setMenu({ c, x, y })}
          />
        );
      })}
      <div className="lineupPad" style={{ height: padBottom }} aria-hidden />
      {!rows.length && <p className="muted lineupEmpty">{empty}</p>}
      {menu && <ChannelMenu c={menu.c} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}

const Row = memo(function Row({ c, selected, np, now, fav, locked, onTune, onMenu }: {
  c: Channel; selected: boolean; np?: Program; now: number; fav: boolean; locked: boolean;
  onTune: (id: string) => void; onMenu: (x: number, y: number) => void;
}) {
  const org = isOrg(c) ? c : undefined;
  const progress = np ? Math.max(0, Math.min(100, ((now - np.start) / (np.end - np.start)) * 100)) : 0;
  const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); };
  return (
    <button
      className={`lineupRow ${selected ? 'selected' : ''}`}
      data-id={c.id}
      data-raw={(org as { rawName?: string } | undefined)?.rawName ?? c.name}
      title={(org as { rawName?: string } | undefined)?.rawName ?? c.name}
      onClick={() => onTune(c.id)}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      aria-current={selected ? 'true' : undefined}
    >
      <span className="lnNum">{c.number}</span>
      <TvMark channel={c} size={34} />
      <span className="lnMain">
        <span className="lnName">
          <b>{org?.displayName ?? c.name}</b>
          {org?.country && <span className="ccBadge">{org.country}</span>}
        </span>
        {np ? (
          <span className="lnNow">
            <span className="np1">{np.title}</span>
            <i className="lnBar"><i style={{ width: `${progress}%` }} /></i>
          </span>
        ) : <small className="lnGroup">{c.group}</small>}
      </span>
      {org && (org.qualityLabel || org.variants.length > 1) && (
        <span className="qBadge" title={org.variants.length > 1 ? `${org.variants.length} sources: ${org.variants.map((v) => v.label).join(', ')}` : undefined}>
          {org.qualityLabel}{org.variants.length > 1 && <small>×{org.variants.length}</small>}
        </span>
      )}
      {locked && <Lock className="lnLock" />}
      <span
        role="button"
        tabIndex={-1}
        className={`lnStar ${fav ? 'on' : ''}`}
        aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
        onClick={(e) => { stop(e); toggleFavorite(c); }}
      ><Star fill={fav ? 'currentColor' : 'none'} /></span>
      <span
        role="button"
        tabIndex={-1}
        className="lnMore"
        aria-label={`Channel menu ${c.name}`}
        onClick={(e) => { stop(e); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onMenu(r.left - 180, r.bottom + 2); }}
      ><MoreVertical /></span>
    </button>
  );
});
