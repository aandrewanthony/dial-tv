import { createPersisted } from './persisted';

export interface SchedulePrefs {
  /** Switch the player when an accepted plan item starts. */
  autoTune: boolean;
  /** …but not while I'm watching another of my teams. */
  dontInterruptMyTeam: boolean;
  /** Reminder (minutes before) put on accepted plan items; null = none. */
  reminderMin: number | null;
  /** Plan games with no personal stake (national TV, close lines, clutch). */
  includeOther: boolean;
  /** Candidate ids pinned to the top / skipped by the user. */
  pinned: string[];
  skipped: string[];
  /** Schedule entry ids that came from an accepted plan (auto-tune only touches these). */
  planned: string[];
}

export const useSchedulePrefs = createPersisted<SchedulePrefs>({
  key: 'schedulePrefs',
  version: 1,
  defaults: () => ({ autoTune: false, dontInterruptMyTeam: true, reminderMin: 10, includeOther: true, pinned: [], skipped: [], planned: [] }),
});
