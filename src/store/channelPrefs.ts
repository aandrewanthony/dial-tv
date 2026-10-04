import { createPersisted } from './persisted';
import type { OrgPrefs } from '../lib/channelOrg';

/** How the user organizes Live TV: merged duplicates, visible groups and their order, names, quality choices. */
export interface ChannelPrefs extends OrgPrefs {
  /** Fold "ESPN", "ESPN FHD", "ESPN 4K"… into one channel with a quality picker. */
  mergeDuplicates: boolean;
  /** Group keys ("US|Sports") the user hid. */
  hiddenGroups: string[];
  /** Group keys in the user's order (groups not listed follow in default order). */
  groupOrder: string[];
  /** Group key → custom label. */
  groupNames: Record<string, string>;
  /** Logical channel id → raw variant id the user picked in the Quality menu. */
  variantChoice: Record<string, string>;
  /** Number channels 1, 2, 3… in the visible order (affects number entry). */
  renumber: boolean;
  /** Logical channel ids, most recent first. */
  recent: string[];
  /** Playlist ids the "Choose your channels" picker already ran for. */
  pickedSources: string[];
  railCollapsed: boolean;
  /** Last group selected in the Live TV rail. */
  railGroup: string;
  /** Rail folds the user opened/closed: country code (or '~sports') → open. Unset = default. */
  railFolds: Record<string, boolean>;
  /** Guide: sport filter ('' = everything, 'any' = all sports, or a sport key) and row order. */
  guideSport: string;
  guideSort: 'live' | 'lineup' | 'name';
}

export const DEFAULT_CHANNEL_PREFS: ChannelPrefs = {
  mergeDuplicates: true,
  hiddenGroups: [],
  groupOrder: [],
  groupNames: {},
  variantChoice: {},
  renumber: false,
  recent: [],
  pickedSources: [],
  railCollapsed: false,
  railGroup: 'all',
  railFolds: {},
  guideSport: '',
  guideSort: 'live',
};

export const useChannelPrefs = createPersisted<ChannelPrefs>({
  key: 'channelPrefs',
  version: 1,
  defaults: () => ({ ...DEFAULT_CHANNEL_PREFS }),
});

export const setChannelPrefs = (p: Partial<ChannelPrefs> | ((s: ChannelPrefs) => Partial<ChannelPrefs>)) =>
  useChannelPrefs.setState((s) => (typeof p === 'function' ? p(s) : p));

/** Remember a watched channel (most recent first, max 20). */
export function pushRecent(id: string) {
  const r = useChannelPrefs.getState().recent;
  if (r[0] === id) return;
  setChannelPrefs({ recent: [id, ...r.filter((x) => x !== id)].slice(0, 20) });
}

export function toggleGroupHidden(key: string, hide?: boolean) {
  setChannelPrefs((s) => {
    const on = hide ?? !s.hiddenGroups.includes(key);
    return { hiddenGroups: on ? (s.hiddenGroups.includes(key) ? s.hiddenGroups : [...s.hiddenGroups, key]) : s.hiddenGroups.filter((k) => k !== key) };
  });
}

export function setVariantChoice(channelId: string, variantId: string | undefined) {
  setChannelPrefs((s) => {
    const v = { ...s.variantChoice };
    if (variantId) v[channelId] = variantId;
    else delete v[channelId];
    return { variantChoice: v };
  });
}
