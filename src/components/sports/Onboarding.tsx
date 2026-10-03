import { useEffect, useState } from 'react';
import { Bell, CalendarPlus, Star, Trophy } from 'lucide-react';
import { useApp } from '../../store/app';
import { LEAGUES, leagueLabel } from '../../lib/sports';
import { TeamGrid, setTeamRule } from '../TeamPicker';
import { Modal, Toggle } from '../ui';
import { requestNotifyPermission } from '../../lib/notify';
import type { League } from '../../types';
import { navigate } from '../../app/router';

/** Show the first-run "set your teams" flow? (No favorites yet and not finished/skipped.) */
export const needsOnboarding = (s: { hydrated: boolean; favTeams: string[]; sportsOnboarded: boolean }) => s.hydrated && !s.sportsOnboarded && s.favTeams.length === 0;

/**
 * Whether to show onboarding. Opens on Game Day the first time (no teams, not done) and then stays
 * open while teams are picked, until finished or skipped.
 */
export function useOnboardingGate(route: string) {
  const need = useApp(needsOnboarding);
  const done = useApp((s) => s.sportsOnboarded);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (need && route === 'home') setOpen(true); }, [need, route]);
  return open && !done;
}

/** First-run: pick leagues → favorite teams → schedule & alerts. */
export function Onboarding() {
  const leagues = useApp((s) => s.leagues);
  const favTeams = useApp((s) => s.favTeams);
  const update = useApp((s) => s.update);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [league, setLeague] = useState<League>(leagues[0] ?? 'nfl');
  const [q, setQ] = useState('');
  const [schedule, setSchedule] = useState(true);
  const [alerts, setAlerts] = useState(true);

  const finish = async () => {
    if (schedule) for (const k of favTeams) setTeamRule(k, true);
    if (alerts) {
      // Never let a permission prompt that is ignored block finishing.
      const ok = await Promise.race([requestNotifyPermission().catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);
      update((s) => ({ settings: { ...s.settings, clutchAlerts: true, notifications: ok || s.settings.notifications } }));
    }
    update(() => ({ sportsOnboarded: true }));
    if (favTeams.length) navigate('teams');
  };
  const skip = () => update(() => ({ sportsOnboarded: true }));

  const toggleLeague = (id: League) =>
    update((s) => ({ leagues: s.leagues.includes(id) ? s.leagues.filter((x) => x !== id) : [...s.leagues, id] }));

  return (
    <Modal title="Set your teams" onClose={skip} wide>
      <div className="onboard">
        <ol className="obSteps">
          {['Leagues', 'Teams', 'Schedule & alerts'].map((t, i) => <li key={t} className={i === step ? 'on' : i < step ? 'done' : ''}>{t}</li>)}
        </ol>
        {step === 0 && (
          <>
            <p className="muted"><Trophy /> Which leagues do you follow? Scores, odds and alerts cover these.</p>
            <div className="chips obLeagues">
              {LEAGUES.map((l) => <button key={l.id} className={leagues.includes(l.id) ? 'on' : ''} aria-pressed={leagues.includes(l.id)} onClick={() => toggleLeague(l.id)}>{l.label}</button>)}
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <p className="muted"><Star /> Tap your teams. You’ll get countdowns, a My Teams page, priority alerts and smarter scheduling.</p>
            <div className="chips">
              {leagues.map((l) => <button key={l} className={league === l ? 'on' : ''} onClick={() => setLeague(l)}>{leagueLabel(l)}</button>)}
            </div>
            <input className="field" placeholder="Filter teams" value={q} onChange={(e) => setQ(e.target.value)} />
            <TeamGrid league={league} filter={q} showRules={false} />
            <p className="small muted">{favTeams.length ? `Following: ${favTeams.map((k) => k.split(':')[1]).join(', ')}` : 'No teams yet.'}</p>
          </>
        )}
        {step === 2 && (
          <div className="col">
            <label className="obOpt"><CalendarPlus /><span><b>Add every game to my schedule</b><small>Creates a rule per team with a 15-minute reminder. Change anytime in Smart Schedule → Rules.</small></span><Toggle on={schedule} onChange={setSchedule} label="Add every game to my schedule" /></label>
            <label className="obOpt"><Bell /><span><b>Alerts</b><small>Clutch-game and reminder alerts, with desktop notifications if you allow them.</small></span><Toggle on={alerts} onChange={setAlerts} label="Alerts" /></label>
          </div>
        )}
        <div className="row">
          <button className="ghost" onClick={skip}>Skip for now</button>
          <span className="spacer" />
          {step > 0 && <button className="ghost" onClick={() => setStep((s) => (s - 1) as 0 | 1)}>Back</button>}
          {step < 2 ? (
            <button className="primary" disabled={step === 0 && !leagues.length} onClick={() => setStep((s) => (s + 1) as 1 | 2)}>Next</button>
          ) : (
            <button className="primary" onClick={() => void finish()}>{favTeams.length ? 'Done' : 'Finish without teams'}</button>
          )}
        </div>
      </div>
    </Modal>
  );
}
