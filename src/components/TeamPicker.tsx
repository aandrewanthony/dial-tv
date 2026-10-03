import { useEffect, useState } from 'react';
import { CalendarPlus, Check, Loader2, Star } from 'lucide-react';
import type { League, Team } from '../types';
import { useApp } from '../store/app';
import { leagueTeams } from '../providers/espn';
import { LEAGUES } from '../lib/sports';
import { Modal, TeamLogo } from './ui';
import { addRuleEntries } from '../hooks/useEngine';

/** Favorite-team picker; optionally creates "add every game" schedule rules. */
export function TeamPicker({ onClose }: { onClose: () => void }) {
  const favTeams = useApp((s) => s.favTeams);
  const rules = useApp((s) => s.rules);
  const update = useApp((s) => s.update);
  const [league, setLeague] = useState<League>('nfl');
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [err, setErr] = useState<string>();
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    setTeams(null);
    setErr(undefined);
    leagueTeams(league).then((t) => live && setTeams(t), (e) => live && setErr(String(e.message ?? e)));
    return () => { live = false; };
  }, [league]);

  const toggleFav = (t: Team) => {
    const key = `${league}:${t.abbr}`;
    update((s) => ({ favTeams: s.favTeams.includes(key) ? s.favTeams.filter((x) => x !== key) : [...s.favTeams, key] }));
  };
  const toggleRule = (t: Team) => {
    const key = `${league}:${t.abbr}`;
    const existing = rules.find((r) => r.kind === 'team' && r.match === key);
    update((s) => ({
      rules: existing ? s.rules.filter((r) => r.id !== existing.id) : [...s.rules, { id: `r${Date.now()}`, kind: 'team', match: key, enabled: true, reminderMin: 15 }],
      leagues: s.leagues.includes(league) ? s.leagues : [...s.leagues, league],
    }));
    setTimeout(addRuleEntries, 0);
  };

  const shown = (teams ?? []).filter((t) => !q || `${t.name} ${t.abbr}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <Modal title="Favorite teams" onClose={onClose} wide>
      <div className="chips">
        {LEAGUES.map((l) => <button key={l.id} className={league === l.id ? 'on' : ''} onClick={() => setLeague(l.id)}>{l.label}</button>)}
      </div>
      <input className="field" placeholder="Filter teams" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <p className="err">Couldn’t load teams: {err}</p>}
      {!teams && !err && <p className="muted"><Loader2 className="spin" /> Loading teams…</p>}
      <div className="teamGrid">
        {shown.map((t) => {
          const key = `${league}:${t.abbr}`;
          const fav = favTeams.includes(key);
          const rule = rules.some((r) => r.kind === 'team' && r.match === key);
          return (
            <div key={t.id} className={`teamPick ${fav ? 'on' : ''}`}>
              <button className="tp" onClick={() => toggleFav(t)}><TeamLogo team={t} size={32} /><span>{t.name}</span>{fav && <Star className="favStar" />}</button>
              <button className={`icon ${rule ? 'on' : ''}`} title={rule ? 'Auto-scheduling every game' : 'Add every game to my schedule'} onClick={() => toggleRule(t)}>
                {rule ? <Check /> : <CalendarPlus />}
              </button>
            </div>
          );
        })}
      </div>
      <p className="muted small">★ = favorite (countdowns, priority in alerts &amp; ticker). Calendar icon = “add every game” rule with a 15-minute reminder.</p>
    </Modal>
  );
}
