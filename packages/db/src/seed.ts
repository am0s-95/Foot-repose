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
  muscatDateTimeToUtc,
  muscatDayUtcRange,
  todayInMuscat,
  type BookingStatus,
} from '@foot-repose/domain';
import { createPool, withTransaction } from './client';
import { loadEnv, requireEnv } from './env';
import { runMigrations } from './migrations';
import { assertSeedSafety } from './seed-guards';

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

/** Time-coherent status mix for a day of bookings, sorted by start time. */
function statusForToday(index: number, count: number): BookingStatus {
  const position = index / count;
  if (position < 0.25) return 'completed';
  if (position < 0.4) return 'in_service';
  if (position < 0.55) return 'checked_in';
  return 'confirmed';
}

loadEnv();
assertSeedSafety({ databaseUrl: requireEnv('DATABASE_URL'), env: process.env });

const pool = createPool(requireEnv('DATABASE_URL'));
try {
  await runMigrations(pool);
  const summary = await withTransaction(pool, async (tx) => {
    await tx.query(
      'TRUNCATE audit_logs, login_rate_limits, sessions, bookings, branch_service_offerings, customers, services, employee_branches, employees, branches RESTART IDENTITY CASCADE',
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
    for (const [i, branch] of BRANCHES.entries()) {
      await insertEmployee(
        `manager.${branch.code.toLowerCase()}@footrepose.example`,
        fictionalName(),
        'branch_manager',
        [branchIds[i]!],
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
    let bookingCount = 0;
    const insertBooking = async (
      branchId: string,
      isoDate: string,
      hour: number,
      minute: number,
      status: BookingStatus,
    ): Promise<void> => {
      // Bookings may only reference services this branch actually offers;
      // price/duration/buffers are copied from the branch's effective
      // offering into the booking's immutable snapshots.
      const offering = pick(offeringsByBranch.get(branchId)!);
      const startsAt = muscatDateTimeToUtc(isoDate, hour, minute);
      const endsAt = new Date(startsAt.getTime() + offering.durationMin * 60_000);
      const therapists = staffByBranch.get(branchId)!;
      await tx.query(
        `INSERT INTO bookings
           (branch_id, customer_id, service_id, assigned_employee_id, status, starts_at, ends_at,
            price_baisa, service_name_snapshot, duration_min_snapshot,
            buffer_before_min_snapshot, buffer_after_min_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          branchId,
          pick(customerIds),
          offering.serviceId,
          pick(therapists),
          status,
          startsAt,
          endsAt,
          offering.priceBaisa,
          offering.serviceName,
          offering.durationMin,
          offering.bufferBeforeMin,
          offering.bufferAfterMin,
        ],
      );
      bookingCount += 1;
    };

    const slotTimes = (): { hour: number; minute: number }[] =>
      Array.from({ length: randInt(8, 10) }, () => ({
        hour: randInt(10, 20),
        minute: pick([0, 15, 30, 45] as const),
      })).sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

    for (const branchId of branchIds) {
      // Yesterday: finished days end in terminal states.
      for (let i = 0; i < randInt(3, 4); i += 1) {
        await insertBooking(
          branchId,
          addDaysToIsoDate(today, -1),
          randInt(10, 20),
          pick([0, 30] as const),
          pick(['completed', 'completed', 'completed', 'no_show', 'cancelled'] as const),
        );
      }
      // Today: a live, time-coherent board.
      const slots = slotTimes();
      for (const [i, slot] of slots.entries()) {
        await insertBooking(branchId, today, slot.hour, slot.minute, statusForToday(i, slots.length));
      }
      // Tomorrow: everything still confirmed.
      for (let i = 0; i < randInt(3, 4); i += 1) {
        await insertBooking(branchId, addDaysToIsoDate(today, 1), randInt(10, 20), pick([0, 30] as const), 'confirmed');
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
          seededFor: today,
        }),
      ],
    );

    return {
      branches: branchIds.length,
      employees: employeeCount,
      customers: customerIds.length,
      bookings: bookingCount,
      offerings: offeringCount,
      today,
    };
  });

  console.log(`Seed complete for ${summary.today} (Asia/Muscat):`);
  console.log(
    `  ${summary.branches} branches, ${summary.employees} employees, ${summary.customers} customers, ${summary.bookings} bookings, ${summary.offerings} offerings`,
  );
  console.log('  Sample logins (password for all: FootRepose!Dev1):');
  console.log('    super admin -> hq.admin@footrepose.example');
  console.log('    manager     -> manager.khw@footrepose.example');
  console.log('    staff       -> staff01.khw@footrepose.example');
} finally {
  await pool.end();
}
