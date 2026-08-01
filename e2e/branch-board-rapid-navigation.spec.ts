import { expect, test, type Page, type Route } from '@playwright/test';
import { login } from './board';

/**
 * Rapid date navigation on the Branch board.
 *
 * The board is driven here against a CONTROLLED bookings endpoint: the real
 * production app, the real login, the real buttons, but every board response is
 * held until this test releases it. That is what makes "clicks issued before the
 * response resolves" a fact rather than a hope — no sleeps decide anything.
 *
 * Two properties are under test and they are different:
 *
 *   INTENT  — N clicks must move exactly N days, whatever is in flight.
 *   COMMIT  — only the newest request may put anything on screen.
 *
 * A run that satisfies one and not the other still loses a user's day.
 */

/** Chosen to cross a year boundary within the eleven-click case. */
const BASE = '2026-12-28';

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A board whose single card names the date it belongs to, so a mismatch
 * between the label and the cards is visible rather than inferred. */
function boardFor(date: string): unknown {
  return {
    branch: { id: '00000000-0000-4000-8000-000000000001', name: 'Foot Repose Al Khuwair' },
    date,
    bookings: [
      {
        id: `00000000-0000-4000-8000-${date.replace(/-/g, '').padStart(12, '0')}`,
        status: 'confirmed',
        startTimeLocal: '10:00',
        endTimeLocal: '10:45',
        priceFormatted: 'OMR 8.500',
        service: { id: '00000000-0000-4000-8000-000000000002', name: `Day ${date}`, durationMin: 45 },
        customer: {
          id: '00000000-0000-4000-8000-000000000003',
          fullName: `Customer ${date}`,
          phone: '+968 24000000',
        },
        assignedEmployee: null,
        allowedActions: [],
      },
    ],
  };
}

interface Gate {
  release: () => void;
  reached: Promise<void>;
  arrived: () => void;
}

/** Controls the bookings endpoint: what was asked for, and when each answer
 * is allowed to come back. */
class BoardApi {
  readonly requested: string[] = [];
  private readonly gates = new Map<string, Gate>();
  private hold = false;
  private failures = new Set<string>();
  private unauthorized = new Set<string>();

  static async install(page: Page): Promise<BoardApi> {
    const api = new BoardApi();
    await page.route('**/api/branches/*/bookings*', async (route: Route) => {
      const url = new URL(route.request().url());
      const date = url.searchParams.get('date') ?? BASE;
      api.requested.push(date);
      const gate = api.gateFor(date);
      gate.arrived();
      if (api.hold) await gate.reached;
      if (api.unauthorized.has(date)) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'unauthorized', message: 'Session expired' },
          }),
        });
        return;
      }
      if (api.failures.has(date)) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal_error', message: `Boom ${date}` } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(boardFor(date)),
      });
    });
    return api;
  }

  private gateFor(date: string): Gate {
    let gate = this.gates.get(date);
    if (!gate) {
      let release!: () => void;
      let arrived!: () => void;
      const reached = new Promise<void>((resolve) => {
        release = resolve;
      });
      const seen = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      gate = { release, reached, arrived };
      this.gates.set(date, gate);
      void seen;
    }
    return gate;
  }

  holdEverything(): void {
    this.hold = true;
  }

  failOn(date: string): void {
    this.failures.add(date);
  }

  expireSessionOn(date: string): void {
    this.unauthorized.add(date);
  }

  /** Let one specific date's response through, in the order the test chooses. */
  release(date: string): void {
    this.gateFor(date).release();
  }

  releaseAll(): void {
    this.hold = false;
    for (const gate of this.gates.values()) gate.release();
  }

  /** Wait until the browser has actually asked for this date. */
  async waitForRequest(date: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.requested.includes(date)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no request for ${date}; saw ${JSON.stringify(this.requested)}`);
  }
}

const label = (page: Page) => page.locator('.date-label');
const cards = (page: Page) => page.locator('li.booking-card .what strong');

async function openBoard(page: Page): Promise<BoardApi> {
  const api = await BoardApi.install(page);
  await login(page);
  await expect(label(page)).toHaveText(BASE);
  return api;
}

/** Click without waiting for any board response in between. */
async function clickRapidly(page: Page, sequence: ('next' | 'previous')[]): Promise<void> {
  for (const direction of sequence) {
    await page
      .getByRole('button', { name: direction === 'next' ? 'Next day' : 'Previous day' })
      .click({ noWaitAfter: true });
  }
}

test('eleven rapid next clicks land exactly eleven days later, across a year boundary', async ({
  page,
}) => {
  const api = await openBoard(page);
  api.holdEverything();

  await clickRapidly(page, Array<'next'>(11).fill('next'));

  const target = addDays(BASE, 11); // 2027-01-08
  expect(target).toBe('2027-01-08');
  await expect(label(page)).toHaveText(target);

  api.releaseAll();
  await expect(cards(page)).toHaveText([`Day ${target}`]);
  expect(api.requested.at(-1)).toBe(target);
});

test('seven rapid previous clicks land exactly seven days earlier', async ({ page }) => {
  const api = await openBoard(page);
  api.holdEverything();

  await clickRapidly(page, Array<'previous'>(7).fill('previous'));

  const target = addDays(BASE, -7); // 2026-12-21
  await expect(label(page)).toHaveText(target);
  api.releaseAll();
  await expect(cards(page)).toHaveText([`Day ${target}`]);
});

test('a mixed rapid sequence keeps its exact net intent', async ({ page }) => {
  const api = await openBoard(page);
  api.holdEverything();

  await clickRapidly(page, ['next', 'next', 'next', 'previous', 'previous', 'next']);

  const target = addDays(BASE, 2);
  await expect(label(page)).toHaveText(target);
  api.releaseAll();
  await expect(cards(page)).toHaveText([`Day ${target}`]);
});

test('an older response released after a newer one cannot overwrite it', async ({ page }) => {
  const api = await openBoard(page);
  api.holdEverything();

  const first = addDays(BASE, 1);
  const second = addDays(BASE, 2);

  // Ask for D+1 and leave it in flight.
  await clickRapidly(page, ['next']);
  await api.waitForRequest(first);

  // Then ask for D+2 and answer THAT one first.
  await clickRapidly(page, ['next']);
  await api.waitForRequest(second);
  api.release(second);
  await expect(cards(page)).toHaveText([`Day ${second}`]);

  // Now let the older answer arrive. It must change nothing.
  api.release(first);
  await page.waitForTimeout(300); // give the stale response every chance to land
  await expect(label(page)).toHaveText(second);
  await expect(cards(page)).toHaveText([`Day ${second}`]);
  await expect(page.locator('.notice')).toHaveCount(0);
});

test('an older FAILURE released after a newer success cannot replace it', async ({ page }) => {
  const api = await openBoard(page);
  api.holdEverything();

  const first = addDays(BASE, 1);
  const second = addDays(BASE, 2);
  api.failOn(first);

  await clickRapidly(page, ['next']);
  await api.waitForRequest(first);
  await clickRapidly(page, ['next']);
  await api.waitForRequest(second);

  api.release(second);
  await expect(cards(page)).toHaveText([`Day ${second}`]);

  api.release(first); // the stale 500
  await page.waitForTimeout(300);
  await expect(page.locator('.notice')).toHaveCount(0);
  await expect(label(page)).toHaveText(second);
  await expect(cards(page)).toHaveText([`Day ${second}`]);
});

test('a genuine failure of the LATEST request is shown, and navigation still works', async ({
  page,
}) => {
  const api = await openBoard(page);
  const broken = addDays(BASE, 1);
  api.failOn(broken);

  await clickRapidly(page, ['next']);
  await expect(page.locator('.notice')).toHaveText(/Boom/);
  await expect(label(page)).toHaveText(broken);

  // The controls are still live, and a later success clears the error.
  await clickRapidly(page, ['next']);
  const recovered = addDays(BASE, 2);
  await expect(label(page)).toHaveText(recovered);
  await expect(cards(page)).toHaveText([`Day ${recovered}`]);
  await expect(page.locator('.notice')).toHaveCount(0);
});

/**
 * Cancellation is deliberately taken away for these two.
 *
 * In production a superseded request is aborted, and an aborted request never
 * reaches the 401 branch at all — which would make this test prove only that
 * `signal.aborted` was true. That is not the property under test. Neutralising
 * `AbortController.prototype.abort` in the page leaves the superseded request to
 * complete for real, so the ONLY thing that can stop a stale 401 from signing
 * the user out is the generation check in the reducer. Production code is
 * untouched; the courtesy mechanism is removed so the authority is what answers.
 */
async function withoutCancellation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    AbortController.prototype.abort = function neutralised(): void {};
  });
}

test('a stale 401 cannot sign the user out of a board that has moved on', async ({ page }) => {
  await withoutCancellation(page);
  const api = await openBoard(page);
  api.holdEverything();

  const first = addDays(BASE, 1);
  const second = addDays(BASE, 2);
  api.expireSessionOn(first);

  // The older request is in flight and will come back 401...
  await clickRapidly(page, ['next']);
  await api.waitForRequest(first);
  // ...and the user has already navigated past it.
  await clickRapidly(page, ['next']);
  await api.waitForRequest(second);

  api.release(second);
  await expect(cards(page)).toHaveText([`Day ${second}`]);

  api.release(first); // the stale 401 settles, uncancelled
  await page.waitForTimeout(500); // every chance to redirect

  await expect(page).toHaveURL('http://localhost:3001/');
  await expect(label(page)).toHaveText(second);
  await expect(cards(page)).toHaveText([`Day ${second}`]);
  await expect(page.locator('.notice')).toHaveCount(0);
});

test('a 401 on the LATEST request still hands over to the login flow', async ({ page }) => {
  await withoutCancellation(page);
  const api = await openBoard(page);
  const expired = addDays(BASE, 1);
  api.expireSessionOn(expired);

  await clickRapidly(page, ['next']);

  await expect(page).toHaveURL(/\/login$/);
});

test('the rendered cards always belong to the rendered date', async ({ page }) => {
  const api = await openBoard(page);
  api.holdEverything();

  await clickRapidly(page, ['next', 'next', 'next']);
  const target = addDays(BASE, 3);

  // While the new target is pending, the board must not show the old day's
  // cards under the new day's label.
  await expect(label(page)).toHaveText(target);
  await expect(cards(page)).toHaveCount(0);

  api.releaseAll();
  await expect(cards(page)).toHaveText([`Day ${target}`]);
});
