/**
 * Development seed. ALL people below are FICTIONAL — no real customer or
 * employee data may ever enter this file. Refuses to run in production.
 *
 * Layout matches the real company shape: 11 branches, 160 employees
 * (1 HQ super admin, 11 branch managers, 148 staff), plus customers and
 * bookings for yesterday / today / tomorrow (Asia/Muscat).
 */
import bcrypt from 'bcryptjs';
import {
  addDaysToIsoDate,
  intersectIntervals,
  intervalsContain,
  materializeBranchHours,
  materializeProviderPresence,
  muscatDateTimeToUtc,
  muscatDayUtcRange,
  occupancyOf,
  todayInMuscat,
  type BookingAction,
  type BookingStatus,
  type UtcInterval,
} from '@foot-repose/domain';
import { createPool, withTransaction, type Queryable } from './client';
import { loadEnv, requireEnv } from './env';
import { runMigrations } from './migrations';
import { assertLiveDevelopmentDatabase, prepareSeed } from './seed-guards';
import { allocateBooking, captureBookingRequirements } from './repositories/allocations';
import { applyBookingTransition } from './repositories/bookings';
import { loadBranchHours, loadProviderSchedule } from './repositories/scheduling';

export const SEED_PASSWORD = 'FootRepose!Dev1';

// Deterministic PRNG so reseeding produces the same dataset (dates aside).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260727);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const randInt = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

const FIRST_NAMES = [
  'Ahmed', 'Fatma', 'Salim', 'Mariam', 'Khalid', 'Aisha', 'Hamed', 'Zainab', 'Nasser', 'Layla',
  'Yousuf', 'Huda', 'Talal', 'Amal', 'Majid', 'Noor', 'Rashid', 'Salma', 'Bilal', 'Asma',
  'Ravi', 'Priya', 'Jose', 'Ana', 'Minh', 'Lin', 'Omar', 'Sara',
];
const LAST_NAMES = [
  'Al-Balushi', 'Al-Harthy', 'Al-Lawati', 'Al-Riyami', 'Al-Hinai', 'Al-Zadjali', 'Al-Abri',
  'Al-Busaidi', 'Kumar', 'Santos', 'Nguyen', 'Chen', 'Fernandes', 'Pillai',
];
const fictionalName = (): string => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;

const BRANCHES = [
  { code: 'KHW', area: 'Al Khuwair' },
  { code: 'RUW', area: 'Ruwi' },
  { code: 'QRM', area: 'Qurum' },
  { code: 'SEB', area: 'Al Seeb' },
  { code: 'MWL', area: 'Al Mawaleh' },
  { code: 'AMR', area: 'Al Amerat' },
  { code: 'BSH', area: 'Bawshar' },
  { code: 'GHB', area: 'Al Ghubrah' },
  { code: 'MTR', area: 'Muttrah' },
  { code: 'HIL', area: 'Al Hail' },
  { code: 'KHD', area: 'Al Khoudh' },
] as const;

const SERVICES = [
  { name: 'Classic Foot Reflexology', durationMin: 45, priceBaisa: 8_500 },
  { name: 'Deep Tissue Foot Massage', durationMin: 60, priceBaisa: 12_000 },
  { name: 'Foot Spa & Scrub', durationMin: 30, priceBaisa: 6_000 },
  { name: 'Hot Stone Foot Therapy', durationMin: 60, priceBaisa: 14_000 },
  { name: 'Express Revive', durationMin: 20, priceBaisa: 4_500 },
  { name: 'Full Leg & Foot Massage', durationMin: 75, priceBaisa: 15_500 },
] as const;

const TOTAL_EMPLOYEES = 160;
const CUSTOMER_COUNT = 48;

loadEnv();

const pool = createPool(requireEnv('DATABASE_URL'));
try {
  // The three textual guards, then the guard that asks the DATABASE rather than
  // a string, then — and only then — migrations. A connection pooler can route
  // a dev-looking URL to production, so a wrong live database must receive no
  // DDL either, not merely no TRUNCATE. `prepareSeed` holds that order in one
  // place so a test can prove migrations are never entered.
  await prepareSeed({
    databaseUrl: requireEnv('DATABASE_URL'),
    env: process.env,
    liveDatabaseName: async () =>
      (await pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db,
    migrate: () => runMigrations(pool).then(() => undefined),
  });

  const summary = await withTransaction(pool, async (tx) => {
    // A pool hands out a different connection than the one checked above, so
    // the destructive transaction re-checks on its own client.
    assertLiveDevelopmentDatabase(
      (await tx.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db,
      'inside the destructive transaction',
    );
    // Allocation and requirement history refuses TRUNCATE unless a session
    // explicitly opts in. SET LOCAL — never plain SET, which would survive the
    // COMMIT and leave the opt-in armed on a pooled connection.
    await tx.query("SET LOCAL foot_repose.allow_history_wipe = 'on'");
    await tx.query(
      `TRUNCATE audit_logs, login_rate_limits, sessions,
                booking_resource_allocations, booking_provider_allocations,
                booking_resource_requirements, booking_resource_requirement_sets, bookings,
                branch_hours_override_windows, branch_hours_overrides, branch_weekly_windows,
                provider_extra_shifts, provider_weekly_windows,
                provider_service_qualifications, provider_branch_assignments,
                branch_service_offering_resources, branch_service_offerings,
                branch_resources, resource_types, customers, services,
                employee_branches, employees, branches RESTART IDENTITY CASCADE`,
    );

    // ---- branches ----
    const branchIds: string[] = [];
    for (const branch of BRANCHES) {
      const result = await tx.query<{ id: string }>(
        'INSERT INTO branches (code, name, area, phone) VALUES ($1, $2, $3, $4) RETURNING id',
        [branch.code, `Foot Repose ${branch.area}`, branch.area, `+968 24${randInt(100000, 999999)}`],
      );
      branchIds.push(result.rows[0]!.id);
    }

    // ---- services ----
    const services: { id: string; name: string; durationMin: number; priceBaisa: number }[] = [];
    for (const service of SERVICES) {
      const result = await tx.query<{ id: string }>(
        'INSERT INTO services (name, duration_min, price_baisa) VALUES ($1, $2, $3) RETURNING id',
        [service.name, service.durationMin, service.priceBaisa],
      );
      services.push({ id: result.rows[0]!.id, ...service });
    }

    // ---- employees (single bcrypt hash: everyone shares the dev password) ----
    const passwordHash = bcrypt.hashSync(SEED_PASSWORD, 10);
    let employeeCount = 0;
    const insertEmployee = async (
      email: string,
      fullName: string,
      role: 'super_admin' | 'branch_manager' | 'staff',
      assignedBranchIds: string[],
    ): Promise<string> => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO employees (email, password_hash, full_name, phone, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [email, passwordHash, fullName, `+968 9${randInt(1000000, 9999999)}`, role],
      );
      const id = result.rows[0]!.id;
      for (const branchId of assignedBranchIds) {
        await tx.query(
          'INSERT INTO employee_branches (employee_id, branch_id) VALUES ($1, $2)',
          [id, branchId],
        );
      }
      employeeCount += 1;
      return id;
    };

    await insertEmployee('hq.admin@footrepose.example', 'Hilal Al-Kharusi', 'super_admin', []);
    const managerIds: string[] = [];
    for (const [i, branch] of BRANCHES.entries()) {
      managerIds.push(
        await insertEmployee(
          `manager.${branch.code.toLowerCase()}@footrepose.example`,
          fictionalName(),
          'branch_manager',
          [branchIds[i]!],
        ),
      );
    }

    const staffByBranch = new Map<string, string[]>(branchIds.map((id) => [id, []]));
    const staffTotal = TOTAL_EMPLOYEES - employeeCount;
    for (let i = 0; i < staffTotal; i += 1) {
      const branchIndex = i % BRANCHES.length;
      const branchId = branchIds[branchIndex]!;
      const perBranchIndex = Math.floor(i / BRANCHES.length) + 1;
      const code = BRANCHES[branchIndex]!.code.toLowerCase();
      const staffId = await insertEmployee(
        `staff${String(perBranchIndex).padStart(2, '0')}.${code}@footrepose.example`,
        fictionalName(),
        'staff',
        [branchId],
      );
      staffByBranch.get(branchId)!.push(staffId);
    }

    // A few floating staff also cover a neighbouring branch.
    for (let i = 0; i < 3; i += 1) {
      const fromBranch = branchIds[i]!;
      const toBranch = branchIds[(i + 1) % branchIds.length]!;
      const floater = staffByBranch.get(fromBranch)![0]!;
      await tx.query(
        'INSERT INTO employee_branches (employee_id, branch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [floater, toBranch],
      );
    }

    // ---- versioned offerings: FICTIONAL per-branch variation ----
    // Proves the catalog supports per-branch prices/durations/history; the
    // real company's prices are business data entered later, never invented.
    const today = todayInMuscat();
    // Validity boundaries sit on Muscat day starts, matching how the API
    // evaluates "effective on date D" (at the start of that Muscat day).
    const currentFrom = muscatDayUtcRange(addDaysToIsoDate(today, -30)).startUtc;
    const historyFrom = muscatDayUtcRange(addDaysToIsoDate(today, -120)).startUtc;
    interface SeededOffering {
      serviceId: string;
      serviceName: string;
      priceBaisa: number;
      durationMin: number;
      bufferBeforeMin: number;
      bufferAfterMin: number;
    }
    const offeringsByBranch = new Map<string, SeededOffering[]>(branchIds.map((id) => [id, []]));
    let offeringCount = 0;
    const insertOffering = async (
      branchId: string,
      service: { id: string; name: string },
      from: Date,
      to: Date | null,
      priceBaisa: number,
      durationMin: number,
      isBookableOnline = true,
    ): Promise<void> => {
      const bufferBeforeMin = 0;
      const bufferAfterMin = 10;
      await tx.query(
        `INSERT INTO branch_service_offerings
           (branch_id, service_id, valid_during, price_baisa, duration_min,
            buffer_before_min, buffer_after_min, is_bookable_online)
         VALUES ($1, $2, tstzrange($3, $4, '[)'), $5, $6, $7, $8, $9)`,
        [
          branchId,
          service.id,
          from,
          to,
          priceBaisa,
          durationMin,
          bufferBeforeMin,
          bufferAfterMin,
          isBookableOnline,
        ],
      );
      offeringCount += 1;
      if (to === null) {
        // Current offerings are the only legal source for seeded bookings.
        offeringsByBranch.get(branchId)!.push({
          serviceId: service.id,
          serviceName: service.name,
          priceBaisa,
          durationMin,
          bufferBeforeMin,
          bufferAfterMin,
        });
      }
    };
    for (const [i, branchId] of branchIds.entries()) {
      const code = BRANCHES[i]!.code;
      for (const service of services) {
        if (code === 'KHD' && service.name === 'Express Revive') continue; // fictional: not offered there
        const priceBaisa = service.priceBaisa + (i % 3) * 500;
        const durationMin =
          code === 'RUW' && service.name === 'Deep Tissue Foot Massage' ? 75 : service.durationMin;
        const bookableOnline = !(code === 'MTR' && service.name === 'Full Leg & Foot Massage');
        if (code === 'KHW' && service.name === 'Classic Foot Reflexology') {
          // history row: an older, cheaper offering that ended 30 days ago
          await insertOffering(branchId, service, historyFrom, currentFrom, priceBaisa - 1000, durationMin);
        }
        await insertOffering(branchId, service, currentFrom, null, priceBaisa, durationMin, bookableOnline);
      }
    }

    // ---- scheduling inputs: FICTIONAL hours and shifts ----
    // The real branches' opening hours and rosters are business data entered
    // later; nothing here is a claim about them. What the shapes DO prove is
    // that the model carries dated versions, a midnight-crossing window, the
    // day-owning override, and cross-branch provider work.
    const scheduleFrom = addDaysToIsoDate(today, -30);
    const scheduleHistoryFrom = addDaysToIsoDate(today, -120);
    const tomorrow = addDaysToIsoDate(today, 1);
    let scheduleRows = 0;

    const insertBranchWindow = async (
      branchId: string,
      validFrom: string,
      validTo: string | null,
      dayOfWeek: number,
      openMinute: number,
      closeMinute: number,
    ): Promise<void> => {
      await tx.query(
        `INSERT INTO branch_weekly_windows
           (branch_id, valid_dates, day_of_week, open_minute, close_minute)
         VALUES ($1, daterange($2::date, $3::date, '[)'), $4, $5, $6)`,
        [branchId, validFrom, validTo, dayOfWeek, openMinute, closeMinute],
      );
      scheduleRows += 1;
    };

    for (const [i, branchId] of branchIds.entries()) {
      const code = BRANCHES[i]!.code;
      for (let dow = 0; dow < 7; dow += 1) {
        // Friday opens late; Muttrah keeps a Saturday night window that runs
        // past midnight — the cyclic-week wrap the schema has to police.
        const [open, close] =
          code === 'MTR' && dow === 6 ? [600, 1500] : dow === 5 ? [840, 1320] : [600, 1320];
        await insertBranchWindow(branchId, scheduleFrom, null, dow, open, close);
      }
      if (code === 'KHW') {
        // superseded version: the branch used to open an hour earlier
        for (let dow = 0; dow < 7; dow += 1) {
          await insertBranchWindow(branchId, scheduleHistoryFrom, scheduleFrom, dow, 540, 1260);
        }
      }
    }

    // Day overrides: one branch shut tomorrow, one open on shortened hours.
    await tx.query(
      `INSERT INTO branch_hours_overrides (branch_id, muscat_date, is_closed, note)
       VALUES ($1, $2::date, true, 'fictional maintenance day')`,
      [branchIds[0]!, tomorrow],
    );
    const overrideOpen = await tx.query<{ id: string }>(
      `INSERT INTO branch_hours_overrides (branch_id, muscat_date, is_closed, note)
       VALUES ($1, $2::date, false, 'fictional shortened day') RETURNING id`,
      [branchIds[1]!, tomorrow],
    );
    await tx.query(
      `INSERT INTO branch_hours_override_windows
         (override_id, header_is_closed, open_minute, close_minute)
       VALUES ($1, false, 960, 1200)`,
      [overrideOpen.rows[0]!.id],
    );
    scheduleRows += 3;

    // Operational branch assignment for every manager and staff member.
    const assign = async (employeeId: string, branchId: string): Promise<void> => {
      await tx.query(
        `INSERT INTO provider_branch_assignments (employee_id, branch_id, valid_dates)
         VALUES ($1, $2, daterange($3::date, NULL, '[)'))`,
        [employeeId, branchId, scheduleFrom],
      );
      scheduleRows += 1;
    };

    // Weekly shifts + breaks, batched per provider. Two rosters that never
    // overlap for the same person, in any branch.
    const ROSTERS = [
      { days: [0, 1, 2, 3, 4], open: 600, close: 1080, breakOpen: 780, breakClose: 810 },
      { days: [6, 0, 1, 2, 3], open: 840, close: 1320, breakOpen: 1020, breakClose: 1050 },
    ] as const;
    const insertWeeklyWindows = async (
      employeeId: string,
      rows: { branchId: string; kind: 'shift' | 'break'; dow: number; open: number; close: number }[],
    ): Promise<void> => {
      const values: unknown[] = [];
      const tuples = rows.map((row) => {
        const n = values.length;
        values.push(employeeId, row.branchId, row.kind, scheduleFrom, row.dow, row.open, row.close);
        return `($${n + 1}, $${n + 2}, $${n + 3}, daterange($${n + 4}::date, NULL, '[)'), $${n + 5}, $${n + 6}, $${n + 7})`;
      });
      await tx.query(
        `INSERT INTO provider_weekly_windows
           (employee_id, branch_id, kind, valid_dates, day_of_week, open_minute, close_minute)
         VALUES ${tuples.join(', ')}`,
        values,
      );
      scheduleRows += rows.length;
    };

    // Staff are qualified for exactly these services; bookings may only ever
    // pick from them. Keeping the set in one place is what stops the old
    // mismatch (qualify for four, book from six) from coming back.
    const qualifiedServices = services.slice(0, 4);
    const qualifiedServiceIds = new Set(qualifiedServices.map((s) => s.id));

    const floaterOf = new Map<string, string>(); // staff id -> neighbouring branch
    for (let i = 0; i < 3; i += 1) {
      floaterOf.set(staffByBranch.get(branchIds[i]!)![0]!, branchIds[(i + 1) % branchIds.length]!);
    }

    for (const [branchIndex, branchId] of branchIds.entries()) {
      const staff = staffByBranch.get(branchId)!;
      await assign(managerIds[branchIndex]!, branchId);
      for (const [staffIndex, staffId] of staff.entries()) {
        await assign(staffId, branchId);
        const roster = ROSTERS[staffIndex % ROSTERS.length]!;
        const rows: {
          branchId: string;
          kind: 'shift' | 'break';
          dow: number;
          open: number;
          close: number;
        }[] = roster.days.flatMap((dow) => [
          { branchId, kind: 'shift' as const, dow, open: roster.open, close: roster.close },
          { branchId, kind: 'break' as const, dow, open: roster.breakOpen, close: roster.breakClose },
        ]);
        const neighbour = floaterOf.get(staffId);
        if (neighbour) {
          // Friday is off in both rosters, so the cross-branch shift cannot
          // collide with the home one.
          await assign(staffId, neighbour);
          rows.push({ branchId: neighbour, kind: 'shift', dow: 5, open: 840, close: 1200 });
        }
        await insertWeeklyWindows(staffId, rows);
        for (const service of qualifiedServices) {
          await tx.query(
            `INSERT INTO provider_service_qualifications (employee_id, service_id, valid_dates)
             VALUES ($1, $2, daterange($3::date, NULL, '[)'))`,
            [staffId, service.id, scheduleFrom],
          );
          scheduleRows += 1;
        }
      }
    }

    // Two concrete extra shifts tomorrow: they OVERRIDE the weekly roster for
    // the minutes they cover, which is how one provider stays in one branch.
    for (const [staffId, neighbour] of [...floaterOf.entries()].slice(0, 2)) {
      await tx.query(
        `INSERT INTO provider_extra_shifts (employee_id, branch_id, during, note)
         VALUES ($1, $2, tstzrange($3, $4, '[)'), 'fictional cover shift')`,
        [staffId, neighbour, muscatDateTimeToUtc(tomorrow, 11), muscatDateTimeToUtc(tomorrow, 13)],
      );
      scheduleRows += 1;
    }

    // ---- physical resources: FICTIONAL inventory ----
    // The real branches' chairs and rooms are business data entered later.
    // Everything here is labelled "Fictional ..." and an invariant proves it.
    const RESOURCE_TYPES = [
      { code: 'chair', name: 'Treatment chair' },
      { code: 'room', name: 'Private room' },
    ] as const;
    const typeIds = new Map<string, string>();
    for (const type of RESOURCE_TYPES) {
      const row = await tx.query<{ id: string }>(
        'INSERT INTO resource_types (code, name) VALUES ($1, $2) RETURNING id',
        [type.code, type.name],
      );
      typeIds.set(type.code, row.rows[0]!.id);
    }

    const CHAIRS_PER_BRANCH = 5;
    const ROOMS_PER_BRANCH = 2;
    interface SeededResource { id: string; typeId: string }
    const resourcesByBranch = new Map<string, SeededResource[]>(branchIds.map((id) => [id, []]));
    let resourceCount = 0;
    const insertResource = async (
      branchId: string,
      typeCode: 'chair' | 'room',
      index: number,
    ): Promise<void> => {
      const prefix = typeCode === 'chair' ? 'CH' : 'RM';
      const row = await tx.query<{ id: string }>(
        `INSERT INTO branch_resources (branch_id, resource_type_id, code, label)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          branchId,
          typeIds.get(typeCode)!,
          `${prefix}${String(index).padStart(2, '0')}`,
          `Fictional ${typeCode === 'chair' ? 'chair' : 'room'} ${index}`,
        ],
      );
      resourcesByBranch.get(branchId)!.push({ id: row.rows[0]!.id, typeId: typeIds.get(typeCode)! });
      resourceCount += 1;
    };
    for (const branchId of branchIds) {
      for (let i = 1; i <= CHAIRS_PER_BRANCH; i += 1) await insertResource(branchId, 'chair', i);
      for (let i = 1; i <= ROOMS_PER_BRANCH; i += 1) await insertResource(branchId, 'room', i);
    }

    // ---- what each offering needs, then CAPTURE it ----
    // Capturing is what turns "no rows" from "never configured" into the
    // explicit statement "this offering needs no resources". After capture the
    // rows are frozen; a change means a new offering version.
    const ROOM_SERVICE = 'Hot Stone Foot Therapy';
    const offeringRows = await tx.query<{ id: string; service_name: string }>(
      `SELECT o.id, s.name AS service_name
       FROM branch_service_offerings o JOIN services s ON s.id = o.service_id
       ORDER BY o.id`,
    );
    let requirementRows = 0;
    for (const offering of offeringRows.rows) {
      const typeCode = offering.service_name === ROOM_SERVICE ? 'room' : 'chair';
      await tx.query(
        `INSERT INTO branch_service_offering_resources (offering_id, resource_type_id, required_qty)
         VALUES ($1, $2, 1)`,
        [offering.id, typeIds.get(typeCode)!],
      );
      requirementRows += 1;
    }
    await tx.query(
      'UPDATE branch_service_offerings SET resource_requirements_captured_at = statement_timestamp()',
    );

    // ---- customers (obviously fictional phone block) ----
    const customerIds: string[] = [];
    for (let i = 0; i < CUSTOMER_COUNT; i += 1) {
      const result = await tx.query<{ id: string }>(
        'INSERT INTO customers (full_name, phone, email) VALUES ($1, $2, $3) RETURNING id',
        [
          fictionalName(),
          `+968 90${String(100000 + i)}`,
          i % 3 === 0 ? `guest${i}@example.com` : null,
        ],
      );
      customerIds.push(result.rows[0]!.id);
    }

    // ---- bookings for yesterday / today / tomorrow (Asia/Muscat) ----
    //
    // Every booking is placed the way the product will have to place one:
    //
    //   * the provider is operationally assigned to the branch AND qualified
    //     for the service (the old seed picked any therapist of the branch and
    //     any of six services while qualifying staff for only four — so it
    //     produced bookings served by an unqualified therapist);
    //   * the FULL derived occupancy — [start - buffer_before, end + buffer_after) —
    //     sits inside the intersection of the branch's materialised opening
    //     hours and that provider's materialised presence in that branch. Not
    //     the service window: prep time before opening is still outside opening
    //     hours;
    //   * neither the provider nor any unit is claimed twice. Placement tracks
    //     what it has already used, and PostgreSQL has the final word anyway.
    //
    // Allocation goes through the real repository (`allocateBooking`), so the
    // seed and the product share one write path — `withUnitOfWork` nests it as
    // a SAVEPOINT inside this transaction.
    const GRID_MINUTES = 15;
    const MINUTE = 60_000;
    const busy = new Map<string, UtcInterval[]>();
    const isFree = (key: string, span: UtcInterval): boolean =>
      !(busy.get(key) ?? []).some(
        (b) => span.startUtc.getTime() < b.endUtc.getTime() && b.startUtc.getTime() < span.endUtc.getTime(),
      );
    const markBusy = (key: string, span: UtcInterval): void => {
      const list = busy.get(key) ?? [];
      list.push(span);
      busy.set(key, list);
    };

    /** Walk the real state machine instead of writing a status straight into
     * the row: that is what releases the claim for cancelled / no_show. */
    const STATUS_PATH: Record<Exclude<BookingStatus, 'confirmed'>, BookingAction[]> = {
      checked_in: ['check_in'],
      in_service: ['check_in', 'start_service'],
      completed: ['check_in', 'start_service', 'complete'],
      cancelled: ['cancel'],
      no_show: ['mark_no_show'],
    };
    const NEXT: Record<BookingAction, BookingStatus> = {
      check_in: 'checked_in',
      start_service: 'in_service',
      complete: 'completed',
      cancel: 'cancelled',
      mark_no_show: 'no_show',
    };

    let bookingCount = 0;
    let allocatedCount = 0;

    const placeBooking = async (
      branchId: string,
      isoDate: string,
      status: BookingStatus,
    ): Promise<boolean> => {
      const branchHours = materializeBranchHours({
        isoDate,
        ...(await loadBranchHours(tx as Queryable, branchId, isoDate)),
      });
      if (branchHours.length === 0) return false;

      const offerings = offeringsByBranch.get(branchId)!;
      for (const staffId of staffByBranch.get(branchId)!) {
        const schedule = await loadProviderSchedule(tx as Queryable, staffId, isoDate);
        const presence = materializeProviderPresence({ isoDate, ...schedule }).filter(
          (p) => p.branchId === branchId,
        );
        if (presence.length === 0) continue;
        const bookable = intersectIntervals(branchHours, presence);

        for (const offering of offerings) {
          if (!qualifiedServiceIds.has(offering.serviceId)) continue;
          const requiredType =
            offering.serviceName === ROOM_SERVICE ? typeIds.get('room')! : typeIds.get('chair')!;
          const unit = resourcesByBranch
            .get(branchId)!
            .find((r) => r.typeId === requiredType);
          if (!unit) continue;

          for (const window of bookable) {
            for (
              let start = window.startUtc.getTime();
              start + offering.durationMin * MINUTE <= window.endUtc.getTime();
              start += GRID_MINUTES * MINUTE
            ) {
              const startsAt = new Date(start);
              const endsAt = new Date(start + offering.durationMin * MINUTE);
              const occupancy = occupancyOf({
                startsAt,
                endsAt,
                bufferBeforeMin: offering.bufferBeforeMin,
                bufferAfterMin: offering.bufferAfterMin,
              });
              // The BUFFERED window must fit, not just the service window.
              if (!intervalsContain([window], [occupancy])) continue;
              const candidates = resourcesByBranch
                .get(branchId)!
                .filter((r) => r.typeId === requiredType && isFree(`r:${r.id}`, occupancy));
              if (!isFree(`p:${staffId}`, occupancy) || candidates.length === 0) continue;
              const chosen = candidates[0]!;

              const inserted = await tx.query<{ id: string }>(
                `INSERT INTO bookings
                   (branch_id, customer_id, service_id, status, starts_at, ends_at,
                    price_baisa, service_name_snapshot, duration_min_snapshot,
                    buffer_before_min_snapshot, buffer_after_min_snapshot)
                 VALUES ($1, $2, $3, 'confirmed', $4, $5, $6, $7, $8, $9, $10)
                 RETURNING id`,
                [
                  branchId,
                  pick(customerIds),
                  offering.serviceId,
                  startsAt,
                  endsAt,
                  offering.priceBaisa,
                  offering.serviceName,
                  offering.durationMin,
                  offering.bufferBeforeMin,
                  offering.bufferAfterMin,
                ],
              );
              const bookingId = inserted.rows[0]!.id;
              await captureBookingRequirements(tx as Queryable, bookingId);
              await allocateBooking(tx as Queryable, bookingId, {
                employeeId: staffId,
                resourceIds: [chosen.id],
              });
              markBusy(`p:${staffId}`, occupancy);
              markBusy(`r:${chosen.id}`, occupancy);
              bookingCount += 1;
              allocatedCount += 1;

              let current: BookingStatus = 'confirmed';
              for (const action of STATUS_PATH[status as Exclude<BookingStatus, 'confirmed'>] ?? []) {
                const result = await applyBookingTransition(
                  tx as Queryable,
                  bookingId,
                  current,
                  NEXT[action],
                );
                if (!result.ok) break;
                current = NEXT[action];
              }
              return true;
            }
          }
        }
      }
      return false;
    };

    const DAY_PLAN: { isoDate: string; statuses: BookingStatus[] }[] = [
      {
        isoDate: addDaysToIsoDate(today, -1),
        statuses: ['completed', 'completed', 'completed', 'no_show', 'cancelled'],
      },
      {
        isoDate: today,
        statuses: ['completed', 'completed', 'in_service', 'checked_in', 'confirmed', 'confirmed'],
      },
      { isoDate: addDaysToIsoDate(today, 1), statuses: ['confirmed', 'confirmed', 'confirmed', 'confirmed'] },
    ];
    for (const branchId of branchIds) {
      for (const day of DAY_PLAN) {
        for (const status of day.statuses) {
          // A day with no capacity left simply yields fewer bookings; the seed
          // never forces one in on top of an existing claim.
          await placeBooking(branchId, day.isoDate, status);
        }
      }
    }

    await tx.query(
      `INSERT INTO audit_logs (actor_employee_id, action, entity_type, metadata)
       VALUES (NULL, 'system.seed', 'database', $1)`,
      [
        JSON.stringify({
          branches: branchIds.length,
          employees: employeeCount,
          customers: customerIds.length,
          bookings: bookingCount,
          resources: resourceCount,
          requirementRows,
          scheduleRows,
          seededFor: today,
        }),
      ],
    );

    return {
      branches: branchIds.length,
      employees: employeeCount,
      customers: customerIds.length,
      bookings: bookingCount,
      allocated: allocatedCount,
      offerings: offeringCount,
      resources: resourceCount,
      requirementRows,
      scheduleRows,
      today,
    };
  });

  console.log(`Seed complete for ${summary.today} (Asia/Muscat):`);
  console.log(
    `  ${summary.branches} branches, ${summary.employees} employees, ${summary.customers} customers, ${summary.bookings} bookings, ${summary.offerings} offerings`,
  );
  console.log(`  ${summary.scheduleRows} scheduling-input rows (branch hours, assignments, shifts)`);
  console.log(
    `  ${summary.resources} fictional resource units, ${summary.requirementRows} offering requirement rows, ${summary.allocated} allocated bookings`,
  );
  console.log('  Sample logins (password for all: FootRepose!Dev1):');
  console.log('    super admin -> hq.admin@footrepose.example');
  console.log('    manager     -> manager.khw@footrepose.example');
  console.log('    staff       -> staff01.khw@footrepose.example');
} finally {
  await pool.end();
}
