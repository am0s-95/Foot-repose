import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDaysToIsoDate, todayInMuscat } from '@foot-repose/domain';
import { saveBranchHoursOverride } from '@foot-repose/db';
import type { Pool } from '@foot-repose/db';
import { closePool, getPool } from '../src/lib/pool';
import { setupFixtures, type Fixtures } from './helpers';

/**
 * `saveBranchHoursOverride` is several statements. These tests prove it is
 * ONE unit of work even when handed a pool: the state transitions both ways,
 * a failure after a real partial write leaves the day byte-identical, and two
 * concurrent writers produce one caller's set — never a blend.
 */
let fx: Fixtures;

const DAY = (): string => addDaysToIsoDate(todayInMuscat(), 3);

interface DayState {
  isClosed: boolean;
  note: string | null;
  windows: string[];
}

async function readDay(db: Pool, branchId: string, muscatDate: string): Promise<DayState | null> {
  const header = await db.query<{ id: string; is_closed: boolean; note: string | null }>(
    'SELECT id, is_closed, note FROM branch_hours_overrides WHERE branch_id = $1 AND muscat_date = $2::date',
    [branchId, muscatDate],
  );
  if (header.rowCount === 0) return null;
  const windows = await db.query<{ open_minute: number; close_minute: number }>(
    `SELECT open_minute, close_minute FROM branch_hours_override_windows
     WHERE override_id = $1 ORDER BY open_minute`,
    [header.rows[0]!.id],
  );
  return {
    isClosed: header.rows[0]!.is_closed,
    note: header.rows[0]!.note,
    windows: windows.rows.map((w) => `${w.open_minute}-${w.close_minute}`),
  };
}

/** Barrier, not a guess: resolves once `atLeast` backends are actually blocked
 * on a lock, observed in pg_locks. Fails the test rather than sleeping a
 * hopeful amount of time. */
async function waitUntilBlocked(db: Pool, atLeast = 1, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const blocked = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted',
    );
    if (blocked.rows[0]!.n >= atLeast) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

beforeEach(async () => {
  fx = await setupFixtures();
});

afterAll(async () => {
  await closePool();
});

describe('override state transitions (called with a Pool)', () => {
  it('goes open-with-windows -> closed and drops every window', async () => {
    const pool = getPool();
    const day = DAY();
    await saveBranchHoursOverride(pool, fx.branchA, {
      muscatDate: day,
      isClosed: false,
      note: 'open first',
      windows: [
        { openMinute: 600, closeMinute: 900 },
        { openMinute: 960, closeMinute: 1200 },
      ],
    });
    expect(await readDay(pool, fx.branchA, day)).toEqual({
      isClosed: false,
      note: 'open first',
      windows: ['600-900', '960-1200'],
    });

    // The composite FK carries header_is_closed, so this is exactly the
    // transition that fails (23503) if the header flips before its windows go.
    await saveBranchHoursOverride(pool, fx.branchA, {
      muscatDate: day,
      isClosed: true,
      note: 'now closed',
    });
    expect(await readDay(pool, fx.branchA, day)).toEqual({
      isClosed: true,
      note: 'now closed',
      windows: [],
    });
  });

  it('goes closed -> open and stores exactly the requested set', async () => {
    const pool = getPool();
    const day = DAY();
    await saveBranchHoursOverride(pool, fx.branchA, { muscatDate: day, isClosed: true, note: 'shut' });
    await saveBranchHoursOverride(pool, fx.branchA, {
      muscatDate: day,
      isClosed: false,
      note: 'reopened',
      windows: [
        { openMinute: 540, closeMinute: 720 },
        { openMinute: 780, closeMinute: 1020 },
      ],
    });
    expect(await readDay(pool, fx.branchA, day)).toEqual({
      isClosed: false,
      note: 'reopened',
      windows: ['540-720', '780-1020'],
    });
  });

  it('replaces the previous window set rather than adding to it', async () => {
    const pool = getPool();
    const day = DAY();
    await saveBranchHoursOverride(pool, fx.branchA, {
      muscatDate: day,
      isClosed: false,
      windows: [{ openMinute: 600, closeMinute: 900 }],
    });
    await saveBranchHoursOverride(pool, fx.branchA, {
      muscatDate: day,
      isClosed: false,
      windows: [{ openMinute: 1000, closeMinute: 1100 }],
    });
    expect((await readDay(pool, fx.branchA, day))!.windows).toEqual(['1000-1100']);
  });
});

describe('rollback after a genuine partial write', () => {
  it('restores the header and the previous windows exactly', async () => {
    const pool = getPool();
    const day = DAY();
    await saveBranchHoursOverride(pool, fx.branchA, {
      muscatDate: day,
      isClosed: false,
      note: 'before',
      windows: [{ openMinute: 480, closeMinute: 540 }],
    });
    const before = await readDay(pool, fx.branchA, day);

    // Fault injection, scoped to this test: fail the SECOND window insert, and
    // report how many rows of this override the transaction had already
    // written — so the error itself proves a partial write existed.
    await pool.query(`
      CREATE FUNCTION fr_test_fail_after_partial_write() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
      DECLARE already int;
      BEGIN
        IF new.open_minute = 999 THEN
          SELECT count(*) INTO already
            FROM branch_hours_override_windows WHERE override_id = new.override_id;
          RAISE EXCEPTION 'fault injection after % row(s) already written in this transaction', already;
        END IF;
        RETURN new;
      END $fn$;
      CREATE TRIGGER fr_test_fail_after_partial_write
        BEFORE INSERT ON branch_hours_override_windows
        FOR EACH ROW EXECUTE FUNCTION fr_test_fail_after_partial_write();
    `);
    try {
      await expect(
        saveBranchHoursOverride(pool, fx.branchA, {
          muscatDate: day,
          isClosed: false,
          note: 'after',
          windows: [
            { openMinute: 600, closeMinute: 900 }, // written
            { openMinute: 999, closeMinute: 1000 }, // blows up
          ],
        }),
      ).rejects.toThrow(/fault injection after 1 row\(s\) already written/);
    } finally {
      await pool.query('DROP TRIGGER fr_test_fail_after_partial_write ON branch_hours_override_windows');
      await pool.query('DROP FUNCTION fr_test_fail_after_partial_write()');
    }

    // Nothing survived: not the deleted old window, not the header note, not
    // the first new window.
    expect(await readDay(pool, fx.branchA, day)).toEqual(before);
    expect(before).toEqual({ isClosed: false, note: 'before', windows: ['480-540'] });
  });
});

describe('two concurrent writers on the same branch and day', () => {
  const SET_A = [
    { openMinute: 600, closeMinute: 700 },
    { openMinute: 800, closeMinute: 900 },
  ];
  const SET_B = [
    { openMinute: 1000, closeMinute: 1100 },
    { openMinute: 1200, closeMinute: 1300 },
  ];

  // Deterministic: the first writer holds the header row lock inside an open
  // transaction; the second is proven to be BLOCKED before the first commits.
  async function race(day: string, firstIsA: boolean): Promise<DayState | null> {
    const pool = getPool();
    const holder = await pool.connect();
    let second: Promise<string>;
    try {
      await holder.query('BEGIN');
      await saveBranchHoursOverride(holder, fx.branchA, {
        muscatDate: day,
        isClosed: false,
        note: firstIsA ? 'A' : 'B',
        windows: firstIsA ? SET_A : SET_B,
      });
      second = saveBranchHoursOverride(pool, fx.branchA, {
        muscatDate: day,
        isClosed: false,
        note: firstIsA ? 'B' : 'A',
        windows: firstIsA ? SET_B : SET_A,
      });
      expect(await waitUntilBlocked(pool, 1)).toBe(true);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    await second;
    return readDay(pool, fx.branchA, day);
  }

  it('leaves one caller\'s complete set — never a blend, a union or a partial delete', async () => {
    for (const [index, firstIsA] of [true, false, true, false, true].entries()) {
      const day = addDaysToIsoDate(todayInMuscat(), 10 + index);
      const state = await race(day, firstIsA);
      const asA = { isClosed: false, note: 'A', windows: ['600-700', '800-900'] };
      const asB = { isClosed: false, note: 'B', windows: ['1000-1100', '1200-1300'] };
      // The second writer serialises behind the first, so the loser's set is
      // the one that survives — whole.
      expect(state).toEqual(firstIsA ? asB : asA);
    }
  }, 60_000);

  /**
   * The harder case: BOTH writers go through the pool, so nothing outside the
   * repository is holding a transaction open.
   *
   * The interleaving is forced, not hoped for. A gate connection holds an
   * advisory lock; a temporary trigger makes every window INSERT wait on that
   * same lock. Writer A therefore stops precisely after it has deleted the
   * previous windows and before it has written its own — the exact moment a
   * non-transactional implementation exposes a half-rewritten day. Writer B
   * then starts and must not be able to walk past it.
   */
  it('cannot blend two sets even when both writers come from the pool', async () => {
    const pool = getPool();
    const day = addDaysToIsoDate(todayInMuscat(), 20);
    await saveBranchHoursOverride(pool, fx.branchA, {
      muscatDate: day,
      isClosed: false,
      note: 'original',
      windows: [{ openMinute: 480, closeMinute: 540 }],
    });

    const gate = await pool.connect();
    let released = false;
    try {
      await gate.query("SELECT pg_advisory_lock(hashtext('fr_override_race'))");
      await pool.query(`
        CREATE FUNCTION fr_test_gate_windows() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('fr_override_race'));
          RETURN new;
        END $fn$;
        CREATE TRIGGER fr_test_gate_windows BEFORE INSERT ON branch_hours_override_windows
          FOR EACH ROW EXECUTE FUNCTION fr_test_gate_windows();
      `);

      const writerA = saveBranchHoursOverride(pool, fx.branchA, {
        muscatDate: day,
        isClosed: false,
        note: 'A',
        windows: SET_A,
      });
      // A is parked inside the trigger, after its DELETE.
      expect(await waitUntilBlocked(pool, 1)).toBe(true);

      const writerB = saveBranchHoursOverride(pool, fx.branchA, {
        muscatDate: day,
        isClosed: false,
        note: 'B',
        windows: SET_B,
      });
      // B must also be stuck — it may not delete or insert anything while A
      // holds the day. Two blocked backends is the proof.
      expect(await waitUntilBlocked(pool, 2)).toBe(true);

      await gate.query("SELECT pg_advisory_unlock(hashtext('fr_override_race'))");
      released = true;
      await writerA;
      await writerB;
    } finally {
      if (!released) {
        await gate.query("SELECT pg_advisory_unlock(hashtext('fr_override_race'))").catch(() => undefined);
      }
      gate.release();
      await pool.query('DROP TRIGGER IF EXISTS fr_test_gate_windows ON branch_hours_override_windows');
      await pool.query('DROP FUNCTION IF EXISTS fr_test_gate_windows()');
    }

    // B was second, so B's set is the whole answer: no 'original' window left
    // behind, no A window mixed in.
    expect(await readDay(pool, fx.branchA, day)).toEqual({
      isClosed: false,
      note: 'B',
      windows: ['1000-1100', '1200-1300'],
    });
  }, 60_000);
});
