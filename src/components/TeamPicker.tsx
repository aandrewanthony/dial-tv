import { useEffect, useState } from 'react';
import { CalendarPlus, Check, Loader2, Star } from 'lucide-react';
import type { League, Team } from '../types';
import { useApp } from '../store/app';
import { leagueTeams } from '../providers/espn';
import { LEAGUES } from '../lib/sports';
import { Modal, TeamLogo } from './ui';
import { addRuleEntries } from '../hooks/useEngine';

export const teamKey = (league: League, t: Pick<Team, 'abbr'>) => `${league}:${t.abbr}`;

/** Add or remove the "add every game to my schedule" rule for a team. */
export function setTeamRule(key: string, on: boolean, reminderMin = 15) {
  const league = key.split(':')[0] as League;
  useApp.getState().update((s) => {
    const existing = s.rules.find((r) => r.kind === 'team' && r.match === key);
    if (!!existing === on) return {};
    return {
      rules: existing ? s.rules.filter((r) => r.id !== existing.id) : [...s.rules, { id: `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`, kind: 'team', match: key, enabled: true, reminderMin }],
      leagues: s.leagues.includes(league) ? s.leagues : [...s.leagues, league],
    };
  });
  setTimeout(addRuleEntries, 0);
}

export function toggleFavTeam(key: string) {
  const league = key.split(':')[0] as League;
  useApp.getState().update((s) => ({
    favTeams: s.favTeams.includes(key) ? s.favTeams.filter((x) => x !== key) : [...s.favTeams, key],
    // Following a team turns its league's scores on.
    leagues: s.leagues.includes(league) ? s.leagues : [...s.leagues, league],
  }));
}

/** Grid of a league's teams: star = favorite, calendar = auto-schedule every game. */
export function TeamGrid({ league, filter = '', showRules = true }: { league: League; filter?: string; showRules?: boolean }) {
  const favTeams = useApp((s) => s.favTeams);
  const rules = useApp((s) => s.rules);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    let live = true;
    setTeams(null);
    setErr(undefined);
    leagueTeams(league).then((t) => live && setTeams(t), (e) => live && setErr(String(e.message ?? e)));
    return () => { live = false; };
  }, [league]);

  const shown = (teams ?? []).filter((t) => !filter || `${t.name} ${t.abbr}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      {err && <p className="err">Couldn’t load teams: {err}</p>}
      {!teams && !err && <p className="muted"><Loader2 className="spin" /> Loading teams…</p>}
      <div className="teamGrid">
        {shown.map((t) => {
          const key = teamKey(league, t);
          const fav = favTeams.includes(key);
          const rule = rules.some((r) => r.kind === 'team' && r.match === key);
          return (
            <div key={t.id} className={`teamPick ${fav ? 'on' : ''}`}>
              <button className="tp" aria-pressed={fav} onClick={() => toggleFavTeam(key)}><TeamLogo team={t} size={32} /><span>{t.name}</span>{fav && <Star className="favStar" />}</button>
              {showRules && (
                <button className={`icon ${rule ? 'on' : ''}`} title={rule ? 'Auto-scheduling every game' : 'Add every game to my schedule'} onClick={() => setTeamRule(key, !rule)}>
                  {rule ? <Check /> : <CalendarPlus />}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Favorite-team picker; optionally creates "add every game" schedule rules. */
export function TeamPicker({ onClose, initialLeague = 'nfl' }: { onClose: () => void; initialLeague?: League }) {
  const [league, setLeague] = useState<League>(initialLeague);
  const [q, setQ] = useState('');
  return (
    <Modal title="Favorite teams" onClose={onClose} wide>
      <div className="chips">
        {LEAGUES.map((l) => <button key={l.id} className={league === l.id ? 'on' : ''} onClick={() => setLeague(l.id)}>{l.label}</button>)}
      </div>
      <input className="field" placeholder="Filter teams" value={q} onChange={(e) => setQ(e.target.value)} />
      <TeamGrid league={league} filter={q} />
      <p className="muted small">★ = favorite (countdowns, My Teams, priority in alerts &amp; planning). Calendar icon = “add every game” rule with a 15-minute reminder.</p>
    </Modal>
  );
}
