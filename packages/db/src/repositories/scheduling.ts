import {
  addDaysToIsoDate,
  breakIsInsideShifts,
  muscatDayUtcRange,
  type OverrideDay,
  type ProviderExtraShift,
  type ProviderWeeklyWindow,
  type WeeklyWindow,
} from '@foot-repose/domain';
import type { Queryable } from '../client';

/**
 * Read + write access to the scheduling INPUTS (branch hours, provider
 * scheduling). Materialising them into instants is the domain package's job;
 * nothing here decides availability.
 *
 * Every read loads the previous Muscat day as well, because a window may
 * cross midnight and carry into the day being asked about.
 */

interface WeeklyRow {
  valid_from: string;
  valid_to: string | null;
  day_of_week: number;
  open_minute: number;
  close_minute: number;
}

const toWeekly = (row: WeeklyRow): WeeklyWindow => ({
  validFrom: row.valid_from,
  validTo: row.valid_to,
  dayOfWeek: row.day_of_week,
  openMinute: row.open_minute,
  closeMinute: row.close_minute,
});

/** Muscat date range a materialisation of `isoDate` may read from: the day
 * itself and the day before it. Half-open, as everywhere else. */
function readRange(isoDate: string): [string, string] {
  return [addDaysToIsoDate(isoDate, -1), addDaysToIsoDate(isoDate, 1)];
}

export interface BranchHoursRows {
  weekly: WeeklyWindow[];
  overrides: OverrideDay[];
}

export async function loadBranchHours(
  db: Queryable,
  branchId: string,
  isoDate: string,
): Promise<BranchHoursRows> {
  const [from, to] = readRange(isoDate);
  const weekly = await db.query<WeeklyRow>(
    `SELECT lower(valid_dates)::text AS valid_from, upper(valid_dates)::text AS valid_to,
            day_of_week, open_minute, close_minute
     FROM branch_weekly_windows
     WHERE branch_id = $1 AND valid_dates && daterange($2::date, $3::date, '[)')
     ORDER BY day_of_week, open_minute`,
    [branchId, from, to],
  );
  const overrides = await db.query<{
    id: string;
    muscat_date: string;
    is_closed: boolean;
    open_minute: number | null;
    close_minute: number | null;
  }>(
    `SELECT o.id, o.muscat_date::text AS muscat_date, o.is_closed,
            w.open_minute, w.close_minute
     FROM branch_hours_overrides o
     LEFT JOIN branch_hours_override_windows w ON w.override_id = o.id
     WHERE o.branch_id = $1 AND o.muscat_date >= $2::date AND o.muscat_date < $3::date
     ORDER BY o.muscat_date, w.open_minute`,
    [branchId, from, to],
  );

  const byDate = new Map<string, OverrideDay>();
  for (const row of overrides.rows) {
    let day = byDate.get(row.muscat_date);
    if (!day) {
      day = { muscatDate: row.muscat_date, isClosed: row.is_closed, windows: [] };
      byDate.set(row.muscat_date, day);
    }
    if (row.open_minute !== null && row.close_minute !== null) {
      day.windows.push({ openMinute: row.open_minute, closeMinute: row.close_minute });
    }
  }
  return { weekly: weekly.rows.map(toWeekly), overrides: [...byDate.values()] };
}

export interface ProviderScheduleRows {
  weekly: ProviderWeeklyWindow[];
  extraShifts: ProviderExtraShift[];
}

export async function loadProviderSchedule(
  db: Queryable,
  employeeId: string,
  isoDate: string,
): Promise<ProviderScheduleRows> {
  const [from, to] = readRange(isoDate);
  const weekly = await db.query<WeeklyRow & { branch_id: string; kind: 'shift' | 'break' }>(
    `SELECT branch_id, kind,
            lower(valid_dates)::text AS valid_from, upper(valid_dates)::text AS valid_to,
            day_of_week, open_minute, close_minute
     FROM provider_weekly_windows
     WHERE employee_id = $1 AND valid_dates && daterange($2::date, $3::date, '[)')
     ORDER BY day_of_week, open_minute`,
    [employeeId, from, to],
  );
  const { startUtc, endUtc } = muscatDayUtcRange(isoDate);
  const extras = await db.query<{ branch_id: string; starts_at: Date; ends_at: Date }>(
    `SELECT branch_id, lower(during) AS starts_at, upper(during) AS ends_at
     FROM provider_extra_shifts
     WHERE employee_id = $1 AND during && tstzrange($2, $3, '[)')
     ORDER BY lower(during)`,
    [employeeId, startUtc, endUtc],
  );
  return {
    weekly: weekly.rows.map((row) => ({
      ...toWeekly(row),
      branchId: row.branch_id,
      kind: row.kind,
    })),
    extraShifts: extras.rows.map((row) => ({
      branchId: row.branch_id,
      startUtc: row.starts_at,
      endUtc: row.ends_at,
    })),
  };
}

/** Providers operationally assigned to a branch on a Muscat date (T5). */
export async function listBranchProviders(
  db: Queryable,
  branchId: string,
  isoDate: string,
): Promise<string[]> {
  const result = await db.query<{ employee_id: string }>(
    `SELECT a.employee_id
     FROM provider_branch_assignments a
     JOIN employees e ON e.id = a.employee_id AND e.is_active
     WHERE a.branch_id = $1 AND a.valid_dates @> $2::date
     ORDER BY a.employee_id`,
    [branchId, isoDate],
  );
  return result.rows.map((row) => row.employee_id);
}

// ------------------------------------------------------------------ writes

export interface WeeklyWindowInput {
  validFrom: string;
  validTo: string | null;
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
}

export async function insertBranchWeeklyWindow(
  db: Queryable,
  branchId: string,
  window: WeeklyWindowInput,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO branch_weekly_windows
       (branch_id, valid_dates, day_of_week, open_minute, close_minute)
     VALUES ($1, daterange($2::date, $3::date, '[)'), $4, $5, $6)
     RETURNING id`,
    [branchId, window.validFrom, window.validTo, window.dayOfWeek, window.openMinute, window.closeMinute],
  );
  return result.rows[0]!.id;
}

export interface OverrideInput {
  muscatDate: string;
  isClosed: boolean;
  note?: string | null;
  windows?: { openMinute: number; closeMinute: number }[];
}

/**
 * Create or replace one branch's override for a Muscat day. Windows under a
 * closed day are rejected by the database itself (composite FK), so this only
 * has to refuse the obviously contradictory call before touching a row.
 */
export async function saveBranchHoursOverride(
  db: Queryable,
  branchId: string,
  input: OverrideInput,
): Promise<string> {
  const windows = input.windows ?? [];
  if (input.isClosed && windows.length > 0) {
    throw new Error('a closed override day cannot carry replacement windows');
  }
  const header = await db.query<{ id: string }>(
    `INSERT INTO branch_hours_overrides (branch_id, muscat_date, is_closed, note)
     VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (branch_id, muscat_date)
       DO UPDATE SET is_closed = excluded.is_closed, note = excluded.note
     RETURNING id`,
    [branchId, input.muscatDate, input.isClosed, input.note ?? null],
  );
  const overrideId = header.rows[0]!.id;
  await db.query('DELETE FROM branch_hours_override_windows WHERE override_id = $1', [overrideId]);
  for (const window of windows) {
    await db.query(
      `INSERT INTO branch_hours_override_windows
         (override_id, header_is_closed, open_minute, close_minute)
       VALUES ($1, false, $2, $3)`,
      [overrideId, window.openMinute, window.closeMinute],
    );
  }
  return overrideId;
}

export interface ProviderWeeklyWindowInput extends WeeklyWindowInput {
  branchId: string;
  kind: 'shift' | 'break';
}

/**
 * Insert a provider shift or break.
 *
 * A break must lie inside that provider's shifts. The database cannot state
 * that (it is a containment across rows of the same table), so it is checked
 * here against the shifts whose validity overlaps the break's own. The check
 * runs in the caller's transaction and takes the row locks it read, so a
 * concurrent shift change cannot slip underneath it.
 */
export async function insertProviderWeeklyWindow(
  db: Queryable,
  employeeId: string,
  window: ProviderWeeklyWindowInput,
): Promise<string> {
  if (window.kind === 'break') {
    const shifts = await db.query<WeeklyRow>(
      `SELECT lower(valid_dates)::text AS valid_from, upper(valid_dates)::text AS valid_to,
              day_of_week, open_minute, close_minute
       FROM provider_weekly_windows
       WHERE employee_id = $1 AND kind = 'shift'
         AND valid_dates && daterange($2::date, $3::date, '[)')
       FOR SHARE`,
      [employeeId, window.validFrom, window.validTo],
    );
    if (!breakIsInsideShifts(window, shifts.rows.map(toWeekly))) {
      throw new Error('a break must lie inside one of the provider\'s shifts');
    }
  }
  const result = await db.query<{ id: string }>(
    `INSERT INTO provider_weekly_windows
       (employee_id, branch_id, kind, valid_dates, day_of_week, open_minute, close_minute)
     VALUES ($1, $2, $3, daterange($4::date, $5::date, '[)'), $6, $7, $8)
     RETURNING id`,
    [
      employeeId,
      window.branchId,
      window.kind,
      window.validFrom,
      window.validTo,
      window.dayOfWeek,
      window.openMinute,
      window.closeMinute,
    ],
  );
  return result.rows[0]!.id;
}

export async function insertProviderExtraShift(
  db: Queryable,
  employeeId: string,
  input: { branchId: string; startUtc: Date; endUtc: Date; note?: string | null },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO provider_extra_shifts (employee_id, branch_id, during, note)
     VALUES ($1, $2, tstzrange($3, $4, '[)'), $5)
     RETURNING id`,
    [employeeId, input.branchId, input.startUtc, input.endUtc, input.note ?? null],
  );
  return result.rows[0]!.id;
}
