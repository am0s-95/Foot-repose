import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDaysToIsoDate, muscatDayUtcRange } from '@foot-repose/domain';
import { closePool, getPool } from '../src/lib/pool';
import { GET as servicesGet } from '../src/app/api/public/branches/[branchId]/services/route';
import { GET as bookingsGet } from '../src/app/api/branches/[branchId]/bookings/route';
import {
  getReq,
  insertBooking,
  insertOffering,
  loginAs,
  setupFixtures,
  type Fixtures,
} from './helpers';

let fx: Fixtures;

const DAY_MS = 24 * 60 * 60 * 1000;

const catalog = (branchId: string, search = '') =>
  servicesGet(getReq(`http://test.local/api/public/branches/${branchId}/services${search}`), {
    params: Promise.resolve({ branchId }),
  });

beforeAll(async () => {
  fx = await setupFixtures();
});

afterAll(async () => {
  await closePool();
});

describe('GET /api/public/branches/:branchId/services', () => {
  it('returns per-branch prices and durations for the same service', async () => {
    const { startUtc } = muscatDayUtcRange(fx.today);
    const from = new Date(startUtc.getTime() - 30 * DAY_MS);
    await insertOffering({
      branchId: fx.branchA,
      serviceId: fx.service,
      from,
      to: null,
      priceBaisa: 8_500,
      durationMin: 45,
    });
    await insertOffering({
      branchId: fx.branchB,
      serviceId: fx.service,
      from,
      to: null,
      priceBaisa: 9_500,
      durationMin: 60,
      isBookableOnline: false,
    });

    const bodyA = await (await catalog(fx.branchA)).json();
    const bodyB = await (await catalog(fx.branchB)).json();

    expect(bodyA.branch.id).toBe(fx.branchA);
    expect(bodyA.services).toHaveLength(1);
    expect(bodyA.services[0]).toMatchObject({
      name: 'Test Reflexology',
      priceBaisa: 8_500,
      priceFormatted: 'OMR 8.500',
      durationMin: 45,
      bufferBeforeMin: 0,
      bufferAfterMin: 10,
      isBookableOnline: true,
    });
    expect(bodyB.services[0]).toMatchObject({
      priceBaisa: 9_500,
      priceFormatted: 'OMR 9.500',
      durationMin: 60,
      isBookableOnline: false,
    });
  });

  it('is public and cacheable for a short time', async () => {
    const response = await catalog(fx.branchA);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('respects half-open [from, to) validity boundaries exactly', async () => {
    const pool = getPool();
    const service = (
      await pool.query<{ id: string }>(
        "INSERT INTO services (name, duration_min, price_baisa) VALUES ('Boundary Service', 30, 5000) RETURNING id",
      )
    ).rows[0]!.id;
    // Old price until (exclusive) the start of today; new price from today on.
    const boundary = muscatDayUtcRange(fx.today).startUtc;
    await insertOffering({
      branchId: fx.branchA,
      serviceId: service,
      from: new Date(boundary.getTime() - 60 * DAY_MS),
      to: boundary,
      priceBaisa: 4_000,
      durationMin: 30,
    });
    await insertOffering({
      branchId: fx.branchA,
      serviceId: service,
      from: boundary,
      to: null,
      priceBaisa: 5_000,
      durationMin: 35,
    });

    const yesterdayBody = await (
      await catalog(fx.branchA, `?date=${fx.yesterday}`)
    ).json();
    const todayBody = await (await catalog(fx.branchA, `?date=${fx.today}`)).json();

    const oldRow = yesterdayBody.services.find(
      (s: { name: string }) => s.name === 'Boundary Service',
    );
    const newRow = todayBody.services.find(
      (s: { name: string }) => s.name === 'Boundary Service',
    );
    expect(oldRow).toMatchObject({ priceBaisa: 4_000, durationMin: 30 });
    expect(newRow).toMatchObject({ priceBaisa: 5_000, durationMin: 35 });
  });

  it('PostgreSQL rejects overlapping validity ranges for the same branch+service', async () => {
    const pool = getPool();
    const service = (
      await pool.query<{ id: string }>(
        "INSERT INTO services (name, duration_min, price_baisa) VALUES ('Overlap Service', 30, 5000) RETURNING id",
      )
    ).rows[0]!.id;
    const from = new Date(Date.now() - 10 * DAY_MS);
    await insertOffering({
      branchId: fx.branchA,
      serviceId: service,
      from,
      to: null,
      priceBaisa: 5_000,
      durationMin: 30,
    });

    let code: string | undefined;
    try {
      await insertOffering({
        branchId: fx.branchA,
        serviceId: service,
        from: new Date(from.getTime() + DAY_MS),
        to: null,
        priceBaisa: 6_000,
        durationMin: 30,
      });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('23P01'); // exclusion_violation

    // A back-to-back, non-overlapping split for another branch is fine.
    const split = new Date(from.getTime() + 5 * DAY_MS);
    await insertOffering({
      branchId: fx.branchB,
      serviceId: service,
      from,
      to: split,
      priceBaisa: 5_000,
      durationMin: 30,
    });
    await insertOffering({
      branchId: fx.branchB,
      serviceId: service,
      from: split,
      to: null,
      priceBaisa: 5_500,
      durationMin: 30,
    });
  });

  it('excludes inactive services and 404s inactive or unknown branches', async () => {
    const pool = getPool();
    const inactiveService = (
      await pool.query<{ id: string }>(
        "INSERT INTO services (name, duration_min, price_baisa, is_active) VALUES ('Retired Service', 30, 5000, false) RETURNING id",
      )
    ).rows[0]!.id;
    await insertOffering({
      branchId: fx.branchA,
      serviceId: inactiveService,
      from: new Date(Date.now() - 10 * DAY_MS),
      to: null,
      priceBaisa: 5_000,
      durationMin: 30,
    });
    const body = await (await catalog(fx.branchA)).json();
    expect(
      body.services.find((s: { name: string }) => s.name === 'Retired Service'),
    ).toBeUndefined();

    const inactiveBranch = (
      await pool.query<{ id: string }>(
        "INSERT INTO branches (code, name, area, phone, is_active) VALUES ('TSX', 'Closed', 'Closed', '+968 24000003', false) RETURNING id",
      )
    ).rows[0]!.id;
    expect((await catalog(inactiveBranch)).status).toBe(404);
    expect((await catalog('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await catalog('not-a-uuid')).status).toBe(404);
  });

  it('rejects malformed and impossible dates', async () => {
    expect((await catalog(fx.branchA, '?date=27-07-2026')).status).toBe(400);
    expect((await catalog(fx.branchA, '?date=2026-02-30')).status).toBe(400);
  });
});

describe('booking snapshots are immutable history', () => {
  it('keeps old bookings unchanged when the service is renamed or resized', async () => {
    const bookingId = await insertBooking({
      branchId: fx.branchA,
      customerId: fx.customerOne,
      serviceId: fx.service,
      status: 'confirmed',
      isoDate: addDaysToIsoDate(fx.today, 1),
      hour: 12,
    });
    const cookie = await loginAs('staff.a@test.example');
    const readBooking = async () => {
      const response = await bookingsGet(
        getReq(
          `http://test.local/api/branches/${fx.branchA}/bookings?date=${addDaysToIsoDate(fx.today, 1)}`,
          cookie,
        ),
        { params: Promise.resolve({ branchId: fx.branchA }) },
      );
      const body = await response.json();
      return body.bookings.find((b: { id: string }) => b.id === bookingId);
    };

    const before = await readBooking();
    expect(before.service).toMatchObject({ name: 'Test Reflexology', durationMin: 45 });

    await getPool().query(
      "UPDATE services SET name = 'Renamed Service', duration_min = 90 WHERE id = $1",
      [fx.service],
    );

    const after = await readBooking();
    expect(after.service).toMatchObject({ name: 'Test Reflexology', durationMin: 45 });

    // Restore for any later assertions in this run.
    await getPool().query(
      "UPDATE services SET name = 'Test Reflexology', duration_min = 45 WHERE id = $1",
      [fx.service],
    );
  });
});
