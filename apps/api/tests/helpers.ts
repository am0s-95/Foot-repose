import bcrypt from 'bcryptjs';
import {
  addDaysToIsoDate,
  muscatDateTimeToUtc,
  todayInMuscat,
  type BookingStatus,
} from '@foot-repose/domain';
import { resetDatabase } from '@foot-repose/db/testing';
import type { Pool } from '@foot-repose/db';
import { getPool } from '../src/lib/pool';
import { POST as loginPost } from '../src/app/api/auth/login/route';

export const TEST_PASSWORD = 'TestPass!1';
const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

export interface TestEmployee {
  id: string;
  email: string;
}

export interface Fixtures {
  branchA: string;
  branchB: string;
  superAdmin: TestEmployee;
  managerA: TestEmployee;
  staffA: TestEmployee;
  staffB: TestEmployee;
  inactive: TestEmployee;
  customerOne: string;
  customerTwo: string;
  service: string;
  today: string;
  yesterday: string;
  bookings: {
    confirmedA: string;
    checkedInA: string;
    inServiceA: string;
    completedA: string;
    confirmedB: string;
    yesterdayA: string;
  };
}

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error(`Refusing to run destructive tests against ${url || '(unset DATABASE_URL)'}`);
  }
}

async function insertBranch(pool: Pool, code: string, name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO branches (code, name, area, phone) VALUES ($1, $2, $2, '+968 24000000') RETURNING id",
    [code, name],
  );
  return result.rows[0]!.id;
}

async function insertEmployee(
  pool: Pool,
  email: string,
  role: 'super_admin' | 'branch_manager' | 'staff',
  branchIds: string[],
  isActive = true,
): Promise<TestEmployee> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO employees (email, password_hash, full_name, role, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [email, TEST_HASH, `Fixture ${email}`, role, isActive],
  );
  const id = result.rows[0]!.id;
  for (const branchId of branchIds) {
    await pool.query('INSERT INTO employee_branches (employee_id, branch_id) VALUES ($1, $2)', [
      id,
      branchId,
    ]);
  }
  return { id, email };
}

interface BookingInput {
  branchId: string;
  customerId: string;
  serviceId: string;
  status: BookingStatus;
  isoDate: string;
  hour: number;
}

export async function insertBooking(input: BookingInput): Promise<string> {
  const startsAt = muscatDateTimeToUtc(input.isoDate, input.hour);
  const endsAt = new Date(startsAt.getTime() + 45 * 60_000);
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO bookings (branch_id, customer_id, service_id, status, starts_at, ends_at, price_baisa)
     VALUES ($1, $2, $3, $4, $5, $6, 8500) RETURNING id`,
    [input.branchId, input.customerId, input.serviceId, input.status, startsAt, endsAt],
  );
  return result.rows[0]!.id;
}

export async function setupFixtures(): Promise<Fixtures> {
  assertTestDatabase();
  const pool = getPool();
  await resetDatabase(pool);

  const branchA = await insertBranch(pool, 'TSA', 'Test Branch A');
  const branchB = await insertBranch(pool, 'TSB', 'Test Branch B');

  const superAdmin = await insertEmployee(pool, 'super@test.example', 'super_admin', []);
  const managerA = await insertEmployee(pool, 'manager.a@test.example', 'branch_manager', [branchA]);
  const staffA = await insertEmployee(pool, 'staff.a@test.example', 'staff', [branchA]);
  const staffB = await insertEmployee(pool, 'staff.b@test.example', 'staff', [branchB]);
  const inactive = await insertEmployee(pool, 'gone@test.example', 'staff', [branchA], false);

  const customers = await pool.query<{ id: string }>(
    `INSERT INTO customers (full_name, phone)
     VALUES ('Test Customer One', '+968 90111111'), ('Other Person Two', '+968 90222222')
     RETURNING id`,
  );
  const customerOne = customers.rows[0]!.id;
  const customerTwo = customers.rows[1]!.id;

  const service = (
    await pool.query<{ id: string }>(
      "INSERT INTO services (name, duration_min, price_baisa) VALUES ('Test Reflexology', 45, 8500) RETURNING id",
    )
  ).rows[0]!.id;

  const today = todayInMuscat();
  const yesterday = addDaysToIsoDate(today, -1);
  const base = { customerId: customerOne, serviceId: service };
  const bookings = {
    confirmedA: await insertBooking({ ...base, branchId: branchA, status: 'confirmed', isoDate: today, hour: 10 }),
    checkedInA: await insertBooking({ ...base, branchId: branchA, status: 'checked_in', isoDate: today, hour: 11 }),
    inServiceA: await insertBooking({ ...base, branchId: branchA, customerId: customerTwo, status: 'in_service', isoDate: today, hour: 12 }),
    completedA: await insertBooking({ ...base, branchId: branchA, status: 'completed', isoDate: today, hour: 13 }),
    confirmedB: await insertBooking({ ...base, branchId: branchB, status: 'confirmed', isoDate: today, hour: 14 }),
    yesterdayA: await insertBooking({ ...base, branchId: branchA, status: 'completed', isoDate: yesterday, hour: 15 }),
  };

  return {
    branchA,
    branchB,
    superAdmin,
    managerA,
    staffA,
    staffB,
    inactive,
    customerOne,
    customerTwo,
    service,
    today,
    yesterday,
    bookings,
  };
}

/** Log in through the real route handler; returns the "fr_session=..." pair. */
export async function loginAs(email: string, password: string = TEST_PASSWORD): Promise<string> {
  const response = await loginPost(
    new Request('http://test.local/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
  if (response.status !== 200) throw new Error(`login as ${email} failed: ${response.status}`);
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('login response is missing set-cookie');
  return setCookie.split(';')[0]!;
}

export const getReq = (url: string, cookie?: string): Request =>
  new Request(url, { headers: cookie ? { cookie } : {} });

export const postReq = (url: string, cookie: string | undefined, body: unknown): Request =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

export async function countAuditRows(action: string, entityId?: string): Promise<number> {
  const result = entityId
    ? await getPool().query<{ count: string }>(
        'SELECT count(*) FROM audit_logs WHERE action = $1 AND entity_id = $2',
        [action, entityId],
      )
    : await getPool().query<{ count: string }>(
        'SELECT count(*) FROM audit_logs WHERE action = $1',
        [action],
      );
  return Number(result.rows[0]!.count);
}
