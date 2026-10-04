import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { channelGroups, orderedChannels, organizedChannels, useApp } from '../../store/app';
import { useChannelPrefs } from '../../store/channelPrefs';
import type { Channel } from '../../types';
import type { OrgChannel } from '../../lib/channelOrg';

/**
 * The organized channel lineup, re-computed when channels, the user's order/hidden lists or the
 * channel preferences change: `live` = visible logical channels in order, `full` = including hidden,
 * `groups` = groups in the user's order, `org` = the raw organization (all groups, alias map).
 */
export function useOrganized() {
  const { channels, channelOrder, hidden, settings } = useApp(useShallow((s) => ({ channels: s.channels, channelOrder: s.channelOrder, hidden: s.hidden, settings: s.settings })));
  const p = useChannelPrefs(useShallow((s) => ({
    mergeDuplicates: s.mergeDuplicates, hiddenGroups: s.hiddenGroups, groupOrder: s.groupOrder, groupNames: s.groupNames,
    variantChoice: s.variantChoice, renumber: s.renumber,
  })));
  return useMemo(() => {
    const prefs = { ...useChannelPrefs.getState(), ...p };
    const sel = { channels, channelOrder, hidden, settings };
    return {
      live: orderedChannels(sel, false, prefs),
      full: orderedChannels(sel, true, prefs),
      groups: channelGroups(sel, prefs),
      org: organizedChannels(sel, prefs),
    };
  }, [channels, channelOrder, hidden, settings, p]);
}

export const isOrg = (c: Channel | undefined): c is OrgChannel => !!c && 'variants' in c;

/** Favorite check that also counts favorites saved on a merged duplicate's id. */
export function isFavorite(favorites: string[], c: Channel) {
  if (favorites.includes(c.id)) return true;
  return isOrg(c) && c.memberIds.length > 1 && c.memberIds.some((id) => favorites.includes(id));
}

export function toggleFavorite(c: Channel) {
  useApp.getState().update((st) => {
    const ids = isOrg(c) ? c.memberIds : [c.id];
    const on = isFavorite(st.favorites, c);
    return { favorites: on ? st.favorites.filter((x) => !ids.includes(x)) : [...st.favorites, c.id] };
  });
}
