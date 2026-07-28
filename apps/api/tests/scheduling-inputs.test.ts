import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addDaysToIsoDate,
  materializeBranchHours,
  materializeProviderPresence,
  muscatDateTimeToUtc,
  todayInMuscat,
} from '@foot-repose/domain';
import {
  insertProviderExtraShift,
  insertProviderWeeklyWindow,
  listBranchProviders,
  loadBranchHours,
  loadProviderSchedule,
  saveBranchHoursOverride,
} from '@foot-repose/db';
import { closePool, getPool } from '../src/lib/pool';
import { setupFixtures, type Fixtures } from './helpers';

/**
 * Slice 2A.2a — scheduling inputs. What PostgreSQL itself must refuse, and
 * what the materialisation layer must compute from real rows.
 *
 * Every expectation below is a SQLSTATE or a database outcome; no HTTP
 * surface exists for these tables yet, by design.
 */
let fx: Fixtures;

/** SQLSTATE of a failing statement, or 'no error' when it succeeded. */
async function sqlstateOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `unexpected: ${(error as Error).message}`;
  }
}

const VALID_FROM = '2030-01-01';

interface WindowInput {
  branchId?: string;
  validFrom?: string;
  validTo?: string | null;
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
}

const insertBranchWindow = (input: WindowInput): Promise<unknown> =>
  getPool().query(
    `INSERT INTO branch_weekly_windows (branch_id, valid_dates, day_of_week, open_minute, close_minute)
     VALUES ($1, daterange($2::date, $3::date, '[)'), $4, $5, $6)`,
    [
      input.branchId ?? fx.branchA,
      input.validFrom ?? VALID_FROM,
      input.validTo ?? null,
      input.dayOfWeek,
      input.openMinute,
      input.closeMinute,
    ],
  );

const insertProviderWindow = (
  employeeId: string,
  branchId: string,
  kind: 'shift' | 'break',
  input: WindowInput,
): Promise<unknown> =>
  getPool().query(
    `INSERT INTO provider_weekly_windows
       (employee_id, branch_id, kind, valid_dates, day_of_week, open_minute, close_minute)
     VALUES ($1, $2, $3, daterange($4::date, $5::date, '[)'), $6, $7, $8)`,
    [
      employeeId,
      branchId,
      kind,
      input.validFrom ?? VALID_FROM,
      input.validTo ?? null,
      input.dayOfWeek,
      input.openMinute,
      input.closeMinute,
    ],
  );

beforeEach(async () => {
  fx = await setupFixtures();
});

afterAll(async () => {
  await closePool();
});

describe('branch weekly windows (T2)', () => {
  it('refuses two windows of the same branch that overlap in the same week', async () => {
    await insertBranchWindow({ dayOfWeek: 0, openMinute: 600, closeMinute: 1320 });
    expect(
      await sqlstateOf(() => insertBranchWindow({ dayOfWeek: 0, openMinute: 1200, closeMinute: 1400 })),
    ).toBe('23P01');
  });

  it('accepts split shifts and the same clock time on a different weekday', async () => {
    await insertBranchWindow({ dayOfWeek: 0, openMinute: 600, closeMinute: 840 });
    expect(
      await sqlstateOf(() => insertBranchWindow({ dayOfWeek: 0, openMinute: 900, closeMinute: 1320 })),
    ).toBe('no error');
    expect(
      await sqlstateOf(() => insertBranchWindow({ dayOfWeek: 1, openMinute: 600, closeMinute: 840 })),
    ).toBe('no error');
  });

  it('catches the Saturday -> Sunday wrap that a naive per-day check would miss', async () => {
    // Saturday 23:00 -> 02:00 occupies the first two hours of the same week.
    await insertBranchWindow({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560 });
    expect(
      await sqlstateOf(() => insertBranchWindow({ dayOfWeek: 0, openMinute: 60, closeMinute: 240 })),
    ).toBe('23P01');
    // ...while a Sunday window after the wrap ends is fine.
    expect(
      await sqlstateOf(() => insertBranchWindow({ dayOfWeek: 0, openMinute: 180, closeMinute: 360 })),
    ).toBe('no error');
  });

  it('lets a superseded version and its replacement meet without overlapping', async () => {
    await insertBranchWindow({ dayOfWeek: 0, openMinute: 540, closeMinute: 1260, validTo: '2030-06-01' });
    expect(
      await sqlstateOf(() =>
        insertBranchWindow({ dayOfWeek: 0, openMinute: 600, closeMinute: 1320, validFrom: '2030-06-01' }),
      ),
    ).toBe('no error');
    // one day of overlap is enough to be refused
    expect(
      await sqlstateOf(() =>
        insertBranchWindow({ dayOfWeek: 0, openMinute: 600, closeMinute: 1320, validFrom: '2030-05-31' }),
      ),
    ).toBe('23P01');
  });

  it('stores validity half-open, and refuses empty or start-less versions', async () => {
    // daterange is a DISCRETE range type, so PostgreSQL canonicalises '[]'
    // to '[)' on the way in — the half-open CHECK cannot fail on
    // inclusivity here (unlike the continuous tstzrange of 0004 and T8).
    // What it does catch is an empty range or a version with no start.
    const stored = await getPool().query<{ lo: boolean; up: boolean; upper: string }>(
      `INSERT INTO branch_weekly_windows (branch_id, valid_dates, day_of_week, open_minute, close_minute)
       VALUES ($1, daterange($2::date, $3::date, '[]'), 0, 600, 1320)
       RETURNING lower_inc(valid_dates) AS lo, upper_inc(valid_dates) AS up, upper(valid_dates)::text AS upper`,
      [fx.branchA, VALID_FROM, '2030-06-01'],
    );
    expect(stored.rows[0]).toEqual({ lo: true, up: false, upper: '2030-06-02' });

    expect(
      await sqlstateOf(() =>
        insertBranchWindow({
          dayOfWeek: 1,
          openMinute: 600,
          closeMinute: 1320,
          validFrom: VALID_FROM,
          validTo: VALID_FROM,
        }),
      ),
    ).toBe('23514');
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO branch_weekly_windows (branch_id, valid_dates, day_of_week, open_minute, close_minute)
           VALUES ($1, daterange(NULL, $2::date, '[)'), 2, 600, 1320)`,
          [fx.branchA, '2030-06-01'],
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a window longer than a day and an impossible weekday', async () => {
    expect(
      await sqlstateOf(() => insertBranchWindow({ dayOfWeek: 0, openMinute: 600, closeMinute: 2100 })),
    ).toBe('23514');
    // An out-of-range weekday is rejected too, but by the generated column:
    // PostgreSQL evaluates generated expressions BEFORE CHECK constraints, so
    // day 7 fails while building its week span (22000) instead of reaching
    // the 0..6 CHECK. The row is refused either way.
    expect(
      await sqlstateOf(() => insertBranchWindow({ dayOfWeek: 7, openMinute: 600, closeMinute: 800 })),
    ).toBe('22000');
  });
});

describe('branch day overrides (T3/T4)', () => {
  const tomorrow = (): string => addDaysToIsoDate(todayInMuscat(), 1);

  it('allows one override per branch per Muscat day', async () => {
    await saveBranchHoursOverride(getPool(), fx.branchA, {
      muscatDate: tomorrow(),
      isClosed: true,
    });
    const duplicate = await sqlstateOf(() =>
      getPool().query(
        `INSERT INTO branch_hours_overrides (branch_id, muscat_date, is_closed)
         VALUES ($1, $2::date, false)`,
        [fx.branchA, tomorrow()],
      ),
    );
    expect(duplicate).toBe('23505');
  });

  it('makes a window under a CLOSED day structurally impossible', async () => {
    const id = await saveBranchHoursOverride(getPool(), fx.branchA, {
      muscatDate: tomorrow(),
      isClosed: true,
    });
    // The composite FK carries header_is_closed = false, so no row matches.
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO branch_hours_override_windows (override_id, header_is_closed, open_minute, close_minute)
           VALUES ($1, false, 600, 1200)`,
          [id],
        ),
      ),
    ).toBe('23503');
    // and the repository refuses the contradictory call before writing at all
    await expect(
      saveBranchHoursOverride(getPool(), fx.branchA, {
        muscatDate: tomorrow(),
        isClosed: true,
        windows: [{ openMinute: 600, closeMinute: 1200 }],
      }),
    ).rejects.toThrow(/closed override day/);
  });

  it('refuses override windows that overlap or cross midnight', async () => {
    const id = await saveBranchHoursOverride(getPool(), fx.branchA, {
      muscatDate: tomorrow(),
      isClosed: false,
      windows: [{ openMinute: 600, closeMinute: 900 }],
    });
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO branch_hours_override_windows (override_id, header_is_closed, open_minute, close_minute)
           VALUES ($1, false, 800, 1000)`,
          [id],
        ),
      ),
    ).toBe('23P01');
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO branch_hours_override_windows (override_id, header_is_closed, open_minute, close_minute)
           VALUES ($1, false, 1380, 1560)`,
          [id],
        ),
      ),
    ).toBe('23514');
  });

  it('treats past days as immutable history', async () => {
    const pool = getPool();
    const yesterday = addDaysToIsoDate(todayInMuscat(), -1);
    expect(
      await sqlstateOf(() =>
        pool.query(
          `INSERT INTO branch_hours_overrides (branch_id, muscat_date, is_closed)
           VALUES ($1, $2::date, true)`,
          [fx.branchA, yesterday],
        ),
      ),
    ).toBe('P0001');

    // A row that became "past" while it sat in the table: plant it with the
    // guard off, then prove the guard refuses every later change to it.
    await pool.query('ALTER TABLE branch_hours_overrides DISABLE TRIGGER branch_hours_overrides_guard');
    const planted = await pool.query<{ id: string }>(
      `INSERT INTO branch_hours_overrides (branch_id, muscat_date, is_closed)
       VALUES ($1, $2::date, false) RETURNING id`,
      [fx.branchA, yesterday],
    );
    await pool.query('ALTER TABLE branch_hours_overrides ENABLE TRIGGER branch_hours_overrides_guard');
    const id = planted.rows[0]!.id;

    expect(
      await sqlstateOf(() =>
        pool.query('UPDATE branch_hours_overrides SET is_closed = true WHERE id = $1', [id]),
      ),
    ).toBe('P0001');
    expect(
      await sqlstateOf(() => pool.query('DELETE FROM branch_hours_overrides WHERE id = $1', [id])),
    ).toBe('P0001');
    expect(
      await sqlstateOf(() =>
        pool.query(
          `INSERT INTO branch_hours_override_windows (override_id, header_is_closed, open_minute, close_minute)
           VALUES ($1, false, 600, 900)`,
          [id],
        ),
      ),
    ).toBe('P0001');

    // Tomorrow, by contrast, is still editable.
    const future = await saveBranchHoursOverride(pool, fx.branchA, {
      muscatDate: addDaysToIsoDate(todayInMuscat(), 1),
      isClosed: false,
      windows: [{ openMinute: 600, closeMinute: 900 }],
    });
    expect(
      await sqlstateOf(() => pool.query('DELETE FROM branch_hours_overrides WHERE id = $1', [future])),
    ).toBe('no error');
  });
});

describe('provider scheduling (T5-T8)', () => {
  it('refuses overlapping shifts for one provider even in different branches', async () => {
    await insertProviderWindow(fx.staffA.id, fx.branchA, 'shift', {
      dayOfWeek: 0,
      openMinute: 600,
      closeMinute: 840,
    });
    expect(
      await sqlstateOf(() =>
        insertProviderWindow(fx.staffA.id, fx.branchB, 'shift', {
          dayOfWeek: 0,
          openMinute: 660,
          closeMinute: 780,
        }),
      ),
    ).toBe('23P01');
    // A break at the same time is a different kind of row and is allowed.
    expect(
      await sqlstateOf(() =>
        insertProviderWindow(fx.staffA.id, fx.branchA, 'break', {
          dayOfWeek: 0,
          openMinute: 660,
          closeMinute: 690,
        }),
      ),
    ).toBe('no error');
    // Another provider at the same time is obviously fine.
    expect(
      await sqlstateOf(() =>
        insertProviderWindow(fx.staffB.id, fx.branchB, 'shift', {
          dayOfWeek: 0,
          openMinute: 660,
          closeMinute: 780,
        }),
      ),
    ).toBe('no error');
  });

  it('refuses overlapping extra shifts for one provider', async () => {
    const pool = getPool();
    const day = '2030-03-10';
    await insertProviderExtraShift(pool, fx.staffA.id, {
      branchId: fx.branchA,
      startUtc: muscatDateTimeToUtc(day, 10),
      endUtc: muscatDateTimeToUtc(day, 14),
    });
    expect(
      await sqlstateOf(() =>
        insertProviderExtraShift(pool, fx.staffA.id, {
          branchId: fx.branchB,
          startUtc: muscatDateTimeToUtc(day, 13),
          endUtc: muscatDateTimeToUtc(day, 15),
        }),
      ),
    ).toBe('23P01');
    // Touching but not overlapping — half-open ranges meet cleanly.
    expect(
      await sqlstateOf(() =>
        insertProviderExtraShift(pool, fx.staffA.id, {
          branchId: fx.branchB,
          startUtc: muscatDateTimeToUtc(day, 14),
          endUtc: muscatDateTimeToUtc(day, 16),
        }),
      ),
    ).toBe('no error');
  });

  it('holds extra shifts to a genuinely half-open, bounded instant range', async () => {
    // tstzrange is CONTINUOUS: nothing canonicalises it, so here the
    // half-open CHECK is doing the work itself.
    const pool = getPool();
    const day = '2030-03-17';
    const insertRaw = (bounds: string, endUtc: Date | null) =>
      pool.query(
        `INSERT INTO provider_extra_shifts (employee_id, branch_id, during)
         VALUES ($1, $2, tstzrange($3, $4, $5))`,
        [fx.staffA.id, fx.branchA, muscatDateTimeToUtc(day, 10), endUtc, bounds],
      );
    expect(await sqlstateOf(() => insertRaw('[]', muscatDateTimeToUtc(day, 12)))).toBe('23514');
    expect(await sqlstateOf(() => insertRaw('[)', null))).toBe('23514');
    expect(await sqlstateOf(() => insertRaw('[)', muscatDateTimeToUtc(day, 12)))).toBe('no error');
  });

  it('dates branch assignments and qualifications without overlap', async () => {
    const pool = getPool();
    const assign = (branchId: string, from: string, to: string | null) =>
      pool.query(
        `INSERT INTO provider_branch_assignments (employee_id, branch_id, valid_dates)
         VALUES ($1, $2, daterange($3::date, $4::date, '[)'))`,
        [fx.staffA.id, branchId, from, to],
      );
    await assign(fx.branchA, VALID_FROM, null);
    expect(await sqlstateOf(() => assign(fx.branchA, '2030-06-01', null))).toBe('23P01');
    // The same person may be assigned to a second branch over the same dates:
    // assignment is not presence — the weekly windows police presence.
    expect(await sqlstateOf(() => assign(fx.branchB, VALID_FROM, null))).toBe('no error');

    const qualify = (from: string) =>
      pool.query(
        `INSERT INTO provider_service_qualifications (employee_id, service_id, valid_dates)
         VALUES ($1, $2, daterange($3::date, NULL, '[)'))`,
        [fx.staffA.id, fx.service, from],
      );
    await qualify(VALID_FROM);
    expect(await sqlstateOf(() => qualify('2030-06-01'))).toBe('23P01');
  });

  describe('break coverage in the write path', () => {
    const NOT_COVERED = /covered by this provider's shifts in the same branch/;
    const addShift = (
      branchId: string,
      validFrom: string,
      validTo: string | null,
      dayOfWeek = 0,
      openMinute = 600,
      closeMinute = 1080,
    ) =>
      insertProviderWeeklyWindow(getPool(), fx.staffA.id, {
        branchId,
        kind: 'shift',
        validFrom,
        validTo,
        dayOfWeek,
        openMinute,
        closeMinute,
      });
    const addBreak = (
      branchId: string,
      validFrom: string,
      validTo: string | null,
      dayOfWeek = 0,
      openMinute = 780,
      closeMinute = 810,
    ) =>
      insertProviderWeeklyWindow(getPool(), fx.staffA.id, {
        branchId,
        kind: 'break',
        validFrom,
        validTo,
        dayOfWeek,
        openMinute,
        closeMinute,
      });

    it('accepts a break its own branch covers for every date and minute', async () => {
      await addShift(fx.branchA, VALID_FROM, null);
      await expect(addBreak(fx.branchA, VALID_FROM, null)).resolves.toBeTypeOf('string');
    });

    it('rejects a break whose minutes fall outside the shift', async () => {
      await addShift(fx.branchA, VALID_FROM, null);
      await expect(addBreak(fx.branchA, VALID_FROM, null, 0, 1050, 1140)).rejects.toThrow(NOT_COVERED);
    });

    it('rejects a break that outlives the shift — overlap is not coverage', async () => {
      await addShift(fx.branchA, '2030-01-01', '2030-03-01'); // ends in February
      await expect(addBreak(fx.branchA, '2030-01-01', null)).rejects.toThrow(NOT_COVERED);
      await expect(addBreak(fx.branchA, '2030-01-01', '2030-03-01')).resolves.toBeTypeOf('string');
    });

    it('rejects a one-day hole between two shift versions', async () => {
      await addShift(fx.branchA, '2030-01-01', '2030-02-01');
      await addShift(fx.branchA, '2030-02-02', '2030-03-01'); // 2030-02-01 is missing
      await expect(addBreak(fx.branchA, '2030-01-01', '2030-03-01')).rejects.toThrow(NOT_COVERED);
    });

    it('accepts two adjacent shift versions that jointly span the break', async () => {
      await addShift(fx.branchA, '2030-01-01', '2030-02-01');
      await addShift(fx.branchA, '2030-02-01', '2030-03-01');
      await expect(addBreak(fx.branchA, '2030-01-01', '2030-03-01')).resolves.toBeTypeOf('string');
    });

    it('does not accept a shift in another branch as justification', async () => {
      // Same provider, same weekday, same minutes — different branch.
      await addShift(fx.branchB, VALID_FROM, null);
      await expect(addBreak(fx.branchA, VALID_FROM, null)).rejects.toThrow(NOT_COVERED);
      await expect(addBreak(fx.branchB, VALID_FROM, null)).resolves.toBeTypeOf('string');
    });

    it('follows a shift that wraps past Saturday midnight', async () => {
      await addShift(fx.branchA, VALID_FROM, null, 6, 1380, 1560); // Sat 23:00 -> 02:00
      await expect(addBreak(fx.branchA, VALID_FROM, null, 0, 30, 60)).resolves.toBeTypeOf('string');
      await expect(addBreak(fx.branchA, VALID_FROM, null, 0, 90, 150)).rejects.toThrow(NOT_COVERED);
    });
  });

  it('lists the providers a branch has on a date', async () => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO provider_branch_assignments (employee_id, branch_id, valid_dates)
       VALUES ($1, $2, daterange($3::date, $4::date, '[)'))`,
      [fx.staffA.id, fx.branchA, VALID_FROM, '2030-06-01'],
    );
    expect(await listBranchProviders(pool, fx.branchA, '2030-05-31')).toEqual([fx.staffA.id]);
    expect(await listBranchProviders(pool, fx.branchA, '2030-06-01')).toEqual([]);
  });
});

describe('materialisation over real rows', () => {
  it('turns stored branch rows into the day the branch is actually open', async () => {
    const pool = getPool();
    // Saturday 23:00 -> 02:00, and a Sunday daytime window.
    await insertBranchWindow({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560 });
    await insertBranchWindow({ dayOfWeek: 0, openMinute: 600, closeMinute: 1320 });
    const sunday = '2030-01-06'; // a Sunday
    const rows = await loadBranchHours(pool, fx.branchA, sunday);
    expect(
      materializeBranchHours({ isoDate: sunday, ...rows }).map(
        (i) => `${i.startUtc.toISOString()}..${i.endUtc.toISOString()}`,
      ),
    ).toEqual([
      `${muscatDateTimeToUtc(sunday, 0).toISOString()}..${muscatDateTimeToUtc(sunday, 2).toISOString()}`,
      `${muscatDateTimeToUtc(sunday, 10).toISOString()}..${muscatDateTimeToUtc(sunday, 22).toISOString()}`,
    ]);
  });

  it('lets an override close a day that the template would have opened', async () => {
    const pool = getPool();
    const today = todayInMuscat();
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    await insertBranchWindow({ dayOfWeek: dow, openMinute: 600, closeMinute: 1320, validFrom: today });
    await saveBranchHoursOverride(pool, fx.branchA, { muscatDate: today, isClosed: true });
    const rows = await loadBranchHours(pool, fx.branchA, today);
    expect(materializeBranchHours({ isoDate: today, ...rows })).toEqual([]);
  });

  it('keeps a provider in one branch when an extra shift covers roster hours', async () => {
    const pool = getPool();
    const sunday = '2030-01-06';
    await insertProviderWindow(fx.staffA.id, fx.branchA, 'shift', {
      dayOfWeek: 0,
      openMinute: 600,
      closeMinute: 840,
    });
    await insertProviderExtraShift(pool, fx.staffA.id, {
      branchId: fx.branchB,
      startUtc: muscatDateTimeToUtc(sunday, 11),
      endUtc: muscatDateTimeToUtc(sunday, 13),
    });
    const rows = await loadProviderSchedule(pool, fx.staffA.id, sunday);
    const presence = materializeProviderPresence({ isoDate: sunday, ...rows });
    expect(
      presence.map((p) => `${p.branchId === fx.branchA ? 'A' : 'B'} ${p.startUtc.toISOString()}`),
    ).toEqual([
      `A ${muscatDateTimeToUtc(sunday, 10).toISOString()}`,
      `B ${muscatDateTimeToUtc(sunday, 11).toISOString()}`,
      `A ${muscatDateTimeToUtc(sunday, 13).toISOString()}`,
    ]);
  });
});
