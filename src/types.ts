// Core domain types shared by providers, stores and UI.

export interface Channel {
  id: string;
  number: number;
  name: string;
  group: string;
  /** Short text mark shown when no logo image is available. */
  mark: string;
  logo?: string;
  url: string;
  /** XMLTV channel id (tvg-id) used to join guide data. */
  tvgId?: string;
  sourceId: string;
  /** Optional backup stream URLs supplied by the playlist owner. */
  fallbackUrls?: string[];
  /** HTTP options from #EXTVLCOPT / attributes (informational in the browser). */
  userAgent?: string;
  referrer?: string;
}

export interface Program {
  id: string;
  channelId: string;
  title: string;
  subtitle?: string;
  description?: string;
  /** Epoch ms, always UTC. */
  start: number;
  end: number;
  category: string;
  isSports?: boolean;
  isNew?: boolean;
}

export type League =
  | 'nfl' | 'nba' | 'mlb' | 'nhl' | 'wnba' | 'ncaaf' | 'ncaam' | 'mls' | 'epl';

export type GameState = 'pre' | 'in' | 'post';

export interface Team {
  id: string;
  abbr: string;
  name: string;
  shortName: string;
  logo?: string;
  color?: string;
  record?: string;
}

export interface GameOdds {
  provider: string;
  /** e.g. "IND -4.5" */
  details?: string;
  spread?: number;
  overUnder?: number;
  favoriteAbbr?: string;
  homeMoneyline?: string;
  awayMoneyline?: string;
}

export interface GameSituation {
  /** e.g. "3rd & 7 at NYJ 22" */
  text?: string;
  possessionTeamId?: string;
  isRedZone?: boolean;
  lastPlay?: string;
  /** MLB */
  outs?: number;
  onBase?: { first: boolean; second: boolean; third: boolean };
}

export interface SportEvent {
  id: string;
  league: League;
  start: number;
  state: GameState;
  /** Display status e.g. "Q4 2:11", "Final", "Sun 1:00 PM". */
  statusText: string;
  period: number;
  /** Seconds remaining in period when known. */
  clock?: number;
  home: Team;
  away: Team;
  homeScore?: number;
  awayScore?: number;
  broadcasts: string[];
  venue?: string;
  odds?: GameOdds;
  situation?: GameSituation;
  /** Week number for weekly leagues. */
  week?: number;
}

export interface ScheduleEntry {
  id: string;
  title: string;
  start: number;
  end: number;
  channelId?: string;
  programId?: string;
  eventId?: string;
  notes?: string;
  /** Minutes before start to remind; undefined = no reminder. */
  reminderMin?: number;
  ruleId?: string;
  color?: string;
}

export type RuleKind = 'team' | 'title' | 'block';

export interface ScheduleRule {
  id: string;
  kind: RuleKind;
  enabled: boolean;
  /** team: `${league}:${teamAbbr}`; title: case-insensitive substring; block: label */
  match: string;
  /** For block rules: weekday mask (0=Sun) + minutes since midnight. */
  days?: number[];
  startMin?: number;
  endMin?: number;
  reminderMin?: number;
}

export interface PlaylistSource {
  id: string;
  name: string;
  kind: 'm3u-url' | 'm3u-file' | 'demo';
  url?: string;
  enabled: boolean;
  lastLoaded?: number;
  channelCount?: number;
  error?: string;
}

export interface EpgSource {
  id: string;
  name: string;
  kind: 'xmltv-url' | 'xmltv-file' | 'demo';
  url?: string;
  enabled: boolean;
  lastLoaded?: number;
  programCount?: number;
  error?: string;
}

/** Pick'em / bet tracker */
export type PickMarket = 'spread' | 'moneyline' | 'total';

export interface BetPick {
  id: string;
  player: string;
  eventId: string;
  league: League;
  /** Game start (epoch ms) so the game can be re-fetched for grading after it leaves the live window. */
  start?: number;
  market: PickMarket;
  /** team abbr for spread/moneyline, 'over' | 'under' for totals */
  side: string;
  /** Line at time of pick (spread from picked side's perspective, or total). */
  line?: number;
  /** American odds string at time of pick, e.g. "-110". */
  price?: string;
  units: number;
  createdAt: number;
  label: string;
  result?: 'win' | 'loss' | 'push';
}
