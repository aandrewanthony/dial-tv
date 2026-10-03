import type { Channel, League, Program, SportEvent } from '../types';

/** Playlist providers return channels for an enabled source. */
export interface PlaylistProvider {
  id: string;
  load(signal?: AbortSignal): Promise<{ channels: Channel[]; epgUrl?: string; skipped: number }>;
}

/** EPG providers return programs already mapped to playlist channel ids. */
export interface EpgProvider {
  id: string;
  load(channels: Channel[], signal?: AbortSignal): Promise<Program[]>;
}

export interface SportsProvider {
  id: string;
  /** Games for one local calendar day. */
  scoreboard(league: League, day: Date, signal?: AbortSignal): Promise<SportEvent[]>;
}

export interface FantasyPlayer {
  id: string;
  name: string;
  position: string;
  /** ESPN-style NFL team abbreviation. */
  team?: string;
  /** e.g. 'QUESTIONABLE', 'OUT' (ESPN). */
  injury?: string;
}

export interface FantasyTeam {
  rosterId: number;
  ownerName: string;
  teamName: string;
  starters: string[];
  points: number;
  playerPoints: Record<string, number>;
  /** Bench player ids (when the platform reports them). */
  bench?: string[];
  /** Projected team total and per-player projections for the week (ESPN). */
  projected?: number;
  playerProjections?: Record<string, number>;
  /** Lineup slot label per starter id, e.g. 'FLEX'. */
  slots?: Record<string, string>;
}

export interface FantasyMatchup {
  week: number;
  me: FantasyTeam;
  opponent?: FantasyTeam;
}

export interface FantasyLeague {
  id: string;
  name: string;
  season: string;
  avatar?: string;
}

export interface FantasyProvider {
  id: string;
  findUser(username: string): Promise<{ userId: string; displayName: string }>;
  leagues(userId: string, season: string): Promise<FantasyLeague[]>;
  currentWeek(): Promise<{ week: number; season: string }>;
  matchup(leagueId: string, userId: string, week: number): Promise<FantasyMatchup>;
  players(): Promise<Record<string, FantasyPlayer>>;
}

/** A fantasy platform's league as the app needs it for one week. */
export interface FantasySnapshot {
  week: number;
  season: string;
  league: FantasyLeague;
  /** Every team in the league (for choosing yours). */
  teams: { id: string; name: string; owner: string }[];
  matchup?: FantasyMatchup;
  players: Record<string, FantasyPlayer>;
}
