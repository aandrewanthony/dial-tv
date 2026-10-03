import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Sports flows with every external API mocked: ESPN (scoreboard, standings, team schedule),
 * The Odds API (recorded fixture) and ESPN Fantasy. Never calls a live API; the Odds API key
 * typed here is a fake test value.
 */
const scoreboard = JSON.parse(readFileSync(resolve('tests/fixtures/espn-nfl.json'), 'utf8'));
const oddsApi = JSON.parse(readFileSync(resolve('tests/fixtures/oddsapi-nfl.json'), 'utf8'));
const espnFF = JSON.parse(readFileSync(resolve('tests/fixtures/espn-ff.json'), 'utf8'));
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' };

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const iso = (ms: number) => new Date(ms).toISOString();

const TEAMS: Record<string, { id: string; abbr: string; name: string; short: string }> = {
  IND: { id: '11', abbr: 'IND', name: 'Indianapolis Colts', short: 'Colts' },
  WSH: { id: '28', abbr: 'WSH', name: 'Washington Commanders', short: 'Commanders' },
  CHI: { id: '3', abbr: 'CHI', name: 'Chicago Bears', short: 'Bears' },
  NYJ: { id: '20', abbr: 'NYJ', name: 'New York Jets', short: 'Jets' },
  CLE: { id: '5', abbr: 'CLE', name: 'Cleveland Browns', short: 'Browns' },
  PIT: { id: '23', abbr: 'PIT', name: 'Pittsburgh Steelers', short: 'Steelers' },
};
const teamJson = (k: string) => ({ id: TEAMS[k].id, abbreviation: k, displayName: TEAMS[k].name, shortDisplayName: TEAMS[k].short });

interface MockState {
  /** IND @ WSH has gone final (IND 27 – WSH 20). */
  final: boolean;
}

async function mock(page: Page, state: MockState) {
  const now = Date.now();
  // Both Sunday games kick off at the same time tomorrow: IND @ WSH and NYJ @ CHI (a conflict).
  const kickoff = now + 26 * 3600_000;
  const scoreboardFor = () => {
    const data = structuredClone(scoreboard);
    data.events[0].date = iso(now - 3 * 3600_000);
    const ind = data.events[1];
    if (state.final) {
      ind.date = iso(now - 4 * 3600_000);
      ind.status = { period: 4, type: { state: 'post', completed: true, name: 'STATUS_FINAL', shortDetail: 'Final' } };
      const [home, away] = ind.competitions[0].competitors;
      home.score = '20';
      away.score = '27';
    } else ind.date = iso(kickoff);
    const chi = structuredClone(data.events[1]);
    chi.id = '999001';
    chi.date = iso(kickoff);
    chi.status = { period: 0, type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } };
    const c = chi.competitions[0];
    c.competitors[0].team = { ...c.competitors[0].team, ...teamJson('CHI'), color: '0b162a' };
    c.competitors[1].team = { ...c.competitors[1].team, ...teamJson('NYJ'), color: '115740' };
    c.broadcasts = [{ market: 'national', names: ['CBS'] }];
    c.geoBroadcasts = [];
    delete c.odds;
    data.events.push(chi);
    return data;
  };

  await page.route('https://site.api.espn.com/**', (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p.endsWith('/football/nfl/standings')) {
      return route.fulfill({ json: { children: [{ standings: { entries: Object.keys(TEAMS).map((k) => ({ team: { ...teamJson(k), logos: [] } })) } }] } });
    }
    if (p.includes('/football/nfl/teams/') && p.endsWith('/schedule')) {
      const id = p.split('/teams/')[1].split('/')[0];
      const abbr = Object.keys(TEAMS).find((k) => TEAMS[k].id === id)!;
      const sb = scoreboardFor();
      const events = sb.events.filter((e: { competitions: { competitors: { team: { abbreviation: string } }[] }[] }) =>
        e.competitions[0].competitors.some((x) => x.team.abbreviation === abbr));
      return route.fulfill({ json: { team: { ...teamJson(abbr), recordSummary: '3-1', standingSummary: '2nd in AFC South' }, events } });
    }
    if (!p.includes('/football/nfl/scoreboard')) return route.fulfill({ json: { events: [], children: [] } });
    if (url.searchParams.get('dates') !== ymd(new Date())) return route.fulfill({ json: { events: [] } });
    return route.fulfill({ json: scoreboardFor() });
  });
  await page.route('https://api.the-odds-api.com/**', (route) => {
    const url = new URL(route.request().url());
    const headers = { ...CORS, 'x-requests-remaining': '497', 'x-requests-used': '3', 'x-requests-last': '3' };
    if (!url.pathname.includes('americanfootball_nfl')) return route.fulfill({ json: [], headers });
    const data = structuredClone(oddsApi);
    data[0].commence_time = iso(kickoff); // Colts @ Commanders lines up with the ESPN game
    return route.fulfill({ json: data, headers });
  });
  await page.route('https://lm-api-reads.fantasy.espn.com/**', (route) => route.fulfill({ json: espnFF, headers: { 'access-control-allow-origin': 'http://localhost:1420' } }));
  await page.route('https://api.sleeper.app/**', (route) => route.fulfill({ status: 404, json: null }));
  await page.route(/espncdn|sleepercdn/, (route) => route.abort());
}

async function onboard(page: Page, teams: string[]) {
  await page.goto('/#/home');
  const dlg = page.getByRole('dialog', { name: 'Set your teams' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Next' }).click();
  for (const t of teams) await dlg.getByRole('button', { name: t }).click();
  await expect(dlg).toContainText('Following:');
  await dlg.getByRole('button', { name: 'Next' }).click();
  await dlg.getByRole('switch', { name: 'Alerts' }).click(); // off: no permission prompt in tests
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(dlg).toBeHidden();
}

let state: MockState;
test.beforeEach(async ({ page }) => {
  state = { final: false };
  await mock(page, state);
});

test('onboarding: pick teams, then My Teams shows the next game with a countdown', async ({ page }) => {
  await onboard(page, ['Indianapolis Colts']);
  await expect(page).toHaveURL(/#\/teams/);
  const card = page.locator('.teamCard').filter({ hasText: 'Indianapolis Colts' });
  await expect(card).toContainText('NEXT GAME');
  await expect(card).toContainText('@ Commanders');
  await expect(card).toContainText('3-1 · 2nd in AFC South');
  await expect(card.getByLabel('Countdown')).toHaveText(/\d+[hd] \d+[hm]/);
  // "Add every game" rule was created during onboarding.
  await page.goto('/#/schedule');
  await expect(page.getByRole('button', { name: /Rules \(1\)/ })).toBeVisible();
  // Doesn't come back once done.
  await page.goto('/#/home');
  await expect(page.getByRole('dialog', { name: 'Set your teams' })).toHaveCount(0);
});

test('bets: odds board compares books and highlights the best price', async ({ page }) => {
  await page.goto('/#/bets');
  await expect(page.locator('.banner')).toContainText('ESPN’s line');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Odds API key').fill('e2e-fake-key');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('Credits left this month: 497')).toBeVisible();
  await page.getByRole('tab', { name: 'Odds board' }).click();
  await page.getByRole('button', { name: 'NFL', exact: true }).click();
  const game = page.locator('.oddsGame').filter({ hasText: 'Colts @ Commanders' });
  await expect(game.locator('thead')).toContainText('FanDuel');
  await expect(game.locator('thead')).toContainText('DraftKings');
  await expect(game.locator('thead')).toContainText('BetMGM');
  // Colts moneyline: DraftKings -205 is the best price among the books.
  const mlRow = game.locator('tr').filter({ hasText: 'Moneyline' });
  await expect(mlRow.locator('.oddCell.best')).toHaveText('-205');
  await expect(game.locator('.oddCell.best').first()).toBeVisible();
  // Pick a line: deep link button to the book.
  await mlRow.locator('.oddCell').first().click();
  await expect(page.locator('.pickBar')).toContainText('IND ML');
  await expect(page.locator('.pickBar').getByRole('button', { name: /Bet at FanDuel/ })).toBeVisible();
  await expect(page.locator('.gamblerLine')).toContainText('1-800-GAMBLER');
});

test('bets: track a bet and it grades itself when the game goes final', async ({ page }) => {
  await page.goto('/#/bets');
  // No key: ESPN's single line (IND -4.5).
  const game = page.locator('.oddsGame').filter({ hasText: 'Colts @ Commanders' });
  await game.locator('tr').filter({ hasText: 'Spread' }).locator('.oddCell').first().click();
  await page.locator('.pickBar').getByRole('button', { name: 'Track bet' }).click();
  const dlg = page.getByRole('dialog', { name: 'Track a bet' });
  await expect(dlg.getByLabel('Line')).toHaveValue('-4.5');
  await dlg.getByLabel('Stake').fill('50');
  await dlg.getByRole('button', { name: 'Save bet' }).click();
  const row = page.locator('.betRow').first();
  await expect(row).toHaveAttribute('data-status', 'open');
  await expect(row).toContainText('IND -4.5');

  state.final = true; // IND wins 27-20: covers -4.5
  await page.reload();
  await page.getByRole('tab', { name: /My bets/ }).click();
  await expect(page.locator('.betRow').first()).toHaveAttribute('data-status', 'won', { timeout: 15_000 });
  await expect(page.locator('.betRow').first()).toContainText('+$45.45');
  await expect(page.locator('.tile').filter({ hasText: 'Record' })).toContainText('1-0-0');
});

test('smart schedule proposes a plan and flags the conflict', async ({ page }) => {
  await onboard(page, ['Indianapolis Colts', 'Chicago Bears']);
  await page.goto('/#/schedule/smart');
  await page.getByRole('button', { name: 'My week' }).click();
  const slot = page.locator('.planSlot.conflict').first();
  await expect(slot).toBeVisible();
  await expect(slot).toContainText('IND @ WSH');
  await expect(slot).toContainText('NYJ @ CHI');
  await expect(slot).toContainText('Also on');
  await expect(page.locator('.banner.warn')).toContainText('overlapping');
  await page.getByRole('button', { name: 'Accept plan' }).click();
  await expect(page.getByRole('button', { name: 'Plan accepted' })).toBeVisible();
  await page.getByRole('button', { name: 'Agenda' }).click();
  await expect(page.locator('.agendaRow').first()).toContainText('@');
});

test('fantasy: connect a public ESPN league and see the matchup', async ({ page }) => {
  await page.goto('/#/fantasy');
  await page.getByRole('tab', { name: 'ESPN' }).click();
  await page.getByLabel('ESPN league id').fill('https://fantasy.espn.com/football/league?leagueId=424242');
  await page.getByRole('button', { name: 'Find league' }).click();
  await page.getByRole('button', { name: /Gridiron Gurus/ }).click();
  await expect(page.locator('.matchHead')).toContainText('Gridiron Gurus');
  await expect(page.locator('.matchHead')).toContainText('Bro Ballers');
  await expect(page.locator('.roster.me')).toContainText('Josh Allen');
  await expect(page.locator('.hints')).toContainText("Ja'Marr Chase");
});
