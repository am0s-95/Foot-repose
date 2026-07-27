import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/lib/pool';
import { GET as bookingsGet } from '../src/app/api/branches/[branchId]/bookings/route';
import { POST as transitionPost } from '../src/app/api/bookings/[bookingId]/transition/route';
import {
  countAuditRows,
  getReq,
  insertBooking,
  loginAs,
  postReq,
  setupFixtures,
  type Fixtures,
} from './helpers';

let fx: Fixtures;
let staffACookie: string;
let staffBCookie: string;
let managerACookie: string;
let superCookie: string;

beforeAll(async () => {
  fx = await setupFixtures();
  staffACookie = await loginAs('staff.a@test.example');
  staffBCookie = await loginAs('staff.b@test.example');
  managerACookie = await loginAs('manager.a@test.example');
  superCookie = await loginAs('super@test.example');
});

afterAll(async () => {
  await closePool();
});

const listBookings = (branchId: string, cookie?: string, search = '') =>
  bookingsGet(getReq(`http://test.local/api/branches/${branchId}/bookings${search}`, cookie), {
    params: Promise.resolve({ branchId }),
  });

const transition = (bookingId: string, cookie: string | undefined, action: string) =>
  transitionPost(postReq(`http://test.local/api/bookings/${bookingId}/transition`, cookie, { action }), {
    params: Promise.resolve({ bookingId }),
  });

describe('GET /api/branches/:branchId/bookings', () => {
  it('requires a session', async () => {
    const response = await listBookings(fx.branchA);
    expect(response.status).toBe(401);
  });

  it("returns today's bookings for the branch only, ordered by start time", async () => {
    const response = await listBookings(fx.branchA, staffACookie);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.date).toBe(fx.today);
    expect(body.branch.id).toBe(fx.branchA);
    const ids = body.bookings.map((b: { id: string }) => b.id);
    expect(ids).toEqual([
      fx.bookings.confirmedA,
      fx.bookings.checkedInA,
      fx.bookings.inServiceA,
      fx.bookings.completedA,
    ]);
    expect(ids).not.toContain(fx.bookings.confirmedB);
    expect(ids).not.toContain(fx.bookings.yesterdayA);
  });

  it('computes allowedActions per actor role on the server', async () => {
    const staffBody = await (await listBookings(fx.branchA, staffACookie)).json();
    const staffConfirmed = staffBody.bookings.find(
      (b: { id: string }) => b.id === fx.bookings.confirmedA,
    );
    expect(staffConfirmed.allowedActions).toEqual(['check_in']);

    const managerBody = await (await listBookings(fx.branchA, managerACookie)).json();
    const managerConfirmed = managerBody.bookings.find(
      (b: { id: string }) => b.id === fx.bookings.confirmedA,
    );
    expect(managerConfirmed.allowedActions.sort()).toEqual(['cancel', 'check_in', 'mark_no_show']);

    const completed = managerBody.bookings.find(
      (b: { id: string }) => b.id === fx.bookings.completedA,
    );
    expect(completed.allowedActions).toEqual([]);
  });

  it('forbids staff from reading another branch, but not super_admin', async () => {
    const forbidden = await listBookings(fx.branchA, staffBCookie);
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('cache-control')).toBe('private, no-store');
    const body = await forbidden.json();
    expect(body.error.code).toBe('forbidden');

    const allowed = await listBookings(fx.branchB, superCookie);
    expect(allowed.status).toBe(200);
  });

  it('filters by date, status and customer search', async () => {
    const yesterday = await (
      await listBookings(fx.branchA, staffACookie, `?date=${fx.yesterday}`)
    ).json();
    expect(yesterday.bookings.map((b: { id: string }) => b.id)).toEqual([fx.bookings.yesterdayA]);

    const confirmed = await (
      await listBookings(fx.branchA, staffACookie, '?status=confirmed')
    ).json();
    expect(confirmed.bookings.map((b: { id: string }) => b.id)).toEqual([fx.bookings.confirmedA]);

    const byName = await (await listBookings(fx.branchA, staffACookie, '?q=Other%20Person')).json();
    expect(byName.bookings.map((b: { id: string }) => b.id)).toEqual([fx.bookings.inServiceA]);

    const byPhone = await (await listBookings(fx.branchA, staffACookie, '?q=90222222')).json();
    expect(byPhone.bookings.map((b: { id: string }) => b.id)).toEqual([fx.bookings.inServiceA]);

    const none = await (await listBookings(fx.branchA, staffACookie, '?q=zzz-no-match')).json();
    expect(none.bookings).toEqual([]);
  });

  it('rejects bad query values and non-uuid branch ids', async () => {
    const badDate = await listBookings(fx.branchA, staffACookie, '?date=27-07-2026');
    expect(badDate.status).toBe(400);

    const badStatus = await listBookings(fx.branchA, staffACookie, '?status=teleported');
    expect(badStatus.status).toBe(400);

    const badBranch = await listBookings('not-a-uuid', superCookie);
    expect(badBranch.status).toBe(404);
  });

  it('exposes Muscat local times and OMR formatting', async () => {
    const body = await (await listBookings(fx.branchA, staffACookie)).json();
    const confirmed = body.bookings.find((b: { id: string }) => b.id === fx.bookings.confirmedA);
    expect(confirmed.startTimeLocal).toBe('10:00');
    expect(confirmed.priceFormatted).toBe('OMR 8.500');
    expect(confirmed.currency).toBe('OMR');
  });
});

describe('POST /api/bookings/:bookingId/transition', () => {
  it('requires a session', async () => {
    const response = await transition(fx.bookings.confirmedA, undefined, 'check_in');
    expect(response.status).toBe(401);
  });

  it('walks the full lifecycle and audits every step', async () => {
    const checkIn = await transition(fx.bookings.confirmedA, staffACookie, 'check_in');
    expect(checkIn.status).toBe(200);
    expect((await checkIn.json()).booking.status).toBe('checked_in');

    const repeat = await transition(fx.bookings.confirmedA, staffACookie, 'check_in');
    expect(repeat.status).toBe(409);
    expect((await repeat.json()).error.code).toBe('invalid_transition');

    const start = await transition(fx.bookings.confirmedA, staffACookie, 'start_service');
    expect(start.status).toBe(200);
    const complete = await transition(fx.bookings.confirmedA, staffACookie, 'complete');
    expect(complete.status).toBe(200);
    expect((await complete.json()).booking.status).toBe('completed');

    const afterTerminal = await transition(fx.bookings.confirmedA, managerACookie, 'cancel');
    expect(afterTerminal.status).toBe(409);

    expect(await countAuditRows('booking.check_in', fx.bookings.confirmedA)).toBe(1);
    expect(await countAuditRows('booking.start_service', fx.bookings.confirmedA)).toBe(1);
    expect(await countAuditRows('booking.complete', fx.bookings.confirmedA)).toBe(1);

    const audit = await getPool().query(
      `SELECT from_status, to_status, actor_employee_id, branch_id
       FROM audit_logs WHERE action = 'booking.check_in' AND entity_id = $1`,
      [fx.bookings.confirmedA],
    );
    expect(audit.rows[0]).toMatchObject({
      from_status: 'confirmed',
      to_status: 'checked_in',
      actor_employee_id: fx.staffA.id,
      branch_id: fx.branchA,
    });
  });

  it('enforces role permissions server-side: staff cannot cancel', async () => {
    const bookingId = await insertBooking({
      branchId: fx.branchA,
      customerId: fx.customerOne,
      serviceId: fx.service,
      status: 'confirmed',
      isoDate: fx.today,
      hour: 16,
    });
    const denied = await transition(bookingId, staffACookie, 'cancel');
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe('forbidden');
    expect(await countAuditRows('booking.cancel', bookingId)).toBe(0);

    const allowed = await transition(bookingId, managerACookie, 'cancel');
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).booking.status).toBe('cancelled');
    expect(await countAuditRows('booking.cancel', bookingId)).toBe(1);
  });

  it('enforces branch assignment server-side', async () => {
    const denied = await transition(fx.bookings.confirmedB, staffACookie, 'check_in');
    expect(denied.status).toBe(403);

    const allowed = await transition(fx.bookings.confirmedB, superCookie, 'check_in');
    expect(allowed.status).toBe(200);
  });

  it('rejects unknown bookings, bad ids and bad actions', async () => {
    const missing = await transition('00000000-0000-4000-8000-000000000000', staffACookie, 'check_in');
    expect(missing.status).toBe(404);

    const badId = await transition('not-a-uuid', staffACookie, 'check_in');
    expect(badId.status).toBe(404);

    const badAction = await transition(fx.bookings.checkedInA, staffACookie, 'teleport');
    expect(badAction.status).toBe(400);
    expect((await badAction.json()).error.code).toBe('validation_error');
  });

  it('blocks transitions for bookings of an inactive branch', async () => {
    const pool = getPool();
    const branchC = (
      await pool.query<{ id: string }>(
        "INSERT INTO branches (code, name, area, phone, is_active) VALUES ('TSC', 'Closing Branch', 'Closing Branch', '+968 24000001', true) RETURNING id",
      )
    ).rows[0]!.id;
    const bookingId = await insertBooking({
      branchId: branchC,
      customerId: fx.customerOne,
      serviceId: fx.service,
      status: 'confirmed',
      isoDate: fx.today,
      hour: 18,
    });
    await pool.query('UPDATE branches SET is_active = false WHERE id = $1', [branchC]);

    const denied = await transition(bookingId, superCookie, 'check_in');
    expect(denied.status).toBe(409);
    expect((await denied.json()).error.code).toBe('conflict');
    expect(await countAuditRows('booking.check_in', bookingId)).toBe(0);

    const row = await pool.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(row.rows[0]!.status).toBe('confirmed');
  });

  it('refuses a transition that races a concurrent branch deactivation', async () => {
    const pool = getPool();
    const branchD = (
      await pool.query<{ id: string }>(
        "INSERT INTO branches (code, name, area, phone) VALUES ('TSD', 'Racing Branch', 'Racing Branch', '+968 24000002') RETURNING id",
      )
    ).rows[0]!.id;
    const bookingId = await insertBooking({
      branchId: branchD,
      customerId: fx.customerOne,
      serviceId: fx.service,
      status: 'confirmed',
      isoDate: fx.today,
      hour: 19,
    });

    // Deactivate the branch in an open transaction (uncommitted row lock),
    // start the transition while it is pending, then commit. The transition
    // must wait on the branch row and then refuse.
    const client = await pool.connect();
    let response: Response;
    try {
      await client.query('BEGIN');
      await client.query('UPDATE branches SET is_active = false WHERE id = $1', [branchD]);
      const pending = transition(bookingId, superCookie, 'check_in');
      await new Promise((resolve) => setTimeout(resolve, 250));
      await client.query('COMMIT');
      response = await pending;
    } finally {
      client.release();
    }

    expect(response.status).toBe(409);
    const row = await pool.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(row.rows[0]!.status).toBe('confirmed');
    expect(await countAuditRows('booking.check_in', bookingId)).toBe(0);
  });

  it('rejects state-changing requests from untrusted origins', async () => {
    const response = await transitionPost(
      new Request(`http://test.local/api/bookings/${fx.bookings.checkedInA}/transition`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: staffACookie,
          origin: 'https://evil.example',
        },
        body: JSON.stringify({ action: 'start_service' }),
      }),
      { params: Promise.resolve({ bookingId: fx.bookings.checkedInA }) },
    );
    expect(response.status).toBe(403);
  });

  it('lets exactly one of two concurrent identical transitions win', async () => {
    const bookingId = await insertBooking({
      branchId: fx.branchA,
      customerId: fx.customerOne,
      serviceId: fx.service,
      status: 'confirmed',
      isoDate: fx.today,
      hour: 17,
    });
    const [first, second] = await Promise.all([
      transition(bookingId, staffACookie, 'check_in'),
      transition(bookingId, managerACookie, 'check_in'),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const row = await getPool().query<{ status: string }>(
      'SELECT status FROM bookings WHERE id = $1',
      [bookingId],
    );
    expect(row.rows[0]!.status).toBe('checked_in');
    expect(await countAuditRows('booking.check_in', bookingId)).toBe(1);
  });
});
