import { useMemo } from 'react';
import { isLive, useApp } from '../../store/app';
import type { OrgChannel, Organized } from '../../lib/channelOrg';

export interface ProviderCategory {
  /** The provider's own category, exactly as the playlist names it ("US Sports", "USA Premium", "NFL"). */
  name: string;
  /** Logical channels in it, in lineup order (a merged channel is in every category one of its copies is in). */
  ids: string[];
}

/**
 * Regular-TV categories: the provider's group-titles as they are, in playlist order — the same
 * tiles the provider's own panel shows — instead of Dial TV's country / category regrouping.
 */
export function useProviderCategories(live: OrgChannel[], org: Organized): ProviderCategory[] {
  const channels = useApp((s) => s.channels);
  return useMemo(() => {
    const order = new Map(live.map((c, i) => [c.id, i]));
    const cats = new Map<string, Set<string>>();
    for (const c of channels) {
      if (!isLive(c)) continue;
      const id = org.alias.get(c.id) ?? c.id;
      if (!order.has(id)) continue;
      const name = (c.group ?? '').trim() || 'Other';
      let s = cats.get(name);
      if (!s) cats.set(name, (s = new Set()));
      s.add(id);
    }
    return [...cats].map(([name, s]) => ({ name, ids: [...s].sort((a, b) => order.get(a)! - order.get(b)!) }));
  }, [channels, live, org]);
}
