import { describe, expect, it } from 'vitest';
import {
  AUDIT_DATABASE_VAR,
  AuditDatabaseError,
  checkWeekdayBranchStability,
  databaseIdentity,
  databaseNameOf,
  resolveAuditDatabaseUrl,
} from '../src/seed-audit-guard';

/**
 * The audit must refuse a shared database BEFORE it wipes anything.
 *
 * This is here because documentation was not enough. The script carried a
 * comment saying it needed its own database, was pointed at the one the test
 * suite was using, and the two reseeded over each other — surfacing as a
 * determinism failure that was indistinguishable from a real bug until the
 * cause was found by hand. A rule enforced only in prose is a rule that gets
 * broken.
 */
const APP = 'postgres://u:p@localhost:5432/foot_repose_dev';
const TEST = 'postgres://u:p@localhost:5432/foot_repose_test';
const AUDIT = 'postgres://u:p@localhost:5432/foot_repose_audit_local';

describe('the audit refuses to share a database', () => {
  it('refuses when the audit URL is not set at all', () => {
    expect(() => resolveAuditDatabaseUrl({ DATABASE_URL: APP })).toThrow(AuditDatabaseError);
    expect(() => resolveAuditDatabaseUrl({})).toThrow(AUDIT_DATABASE_VAR);
    expect(() => resolveAuditDatabaseUrl({ [AUDIT_DATABASE_VAR]: '   ' })).toThrow(
      AuditDatabaseError,
    );
  });

  it('refuses when it points at the application database', () => {
    expect(() =>
      resolveAuditDatabaseUrl({ [AUDIT_DATABASE_VAR]: APP, DATABASE_URL: APP }),
    ).toThrow(/same database as DATABASE_URL/);
  });

  it('refuses when it points at the integration-test database', () => {
    // The exact collision that actually happened.
    expect(() =>
      resolveAuditDatabaseUrl({ [AUDIT_DATABASE_VAR]: TEST, TEST_DATABASE_URL: TEST }),
    ).toThrow(/same database as TEST_DATABASE_URL/);
  });

  it('sees through cosmetic differences in the URL', () => {
    // A trailing slash or a query parameter must not disguise the same
    // database as a different one.
    expect(() =>
      resolveAuditDatabaseUrl({
        [AUDIT_DATABASE_VAR]: `${TEST}?sslmode=disable`,
        TEST_DATABASE_URL: `${TEST}/`,
      }),
    ).toThrow(AuditDatabaseError);
  });

  it('accepts a genuinely separate database', () => {
    expect(
      resolveAuditDatabaseUrl({
        [AUDIT_DATABASE_VAR]: AUDIT,
        DATABASE_URL: APP,
        TEST_DATABASE_URL: TEST,
      }),
    ).toBe(AUDIT);
  });

  it('names the database without ever printing credentials', () => {
    expect(databaseNameOf(AUDIT)).toBe('foot_repose_audit_local');
    expect(databaseNameOf(AUDIT)).not.toContain('p@');
    let message = '';
    try {
      resolveAuditDatabaseUrl({ [AUDIT_DATABASE_VAR]: TEST, TEST_DATABASE_URL: TEST });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('foot_repose_test');
    expect(message).not.toContain('u:p');
  });
});

describe('two URLs for one database produce one identity', () => {
  const CANONICAL = 'postgres://u:p@localhost:5432/foot_repose_test';

  it.each([
    ['an omitted default port', 'postgres://u:p@localhost/foot_repose_test'],
    ['the postgresql: spelling', 'postgresql://u:p@localhost:5432/foot_repose_test'],
    ['hostname case', 'postgres://u:p@LOCALHOST:5432/foot_repose_test'],
    ['a trailing root dot', 'postgres://u:p@localhost.:5432/foot_repose_test'],
    ['a trailing slash', 'postgres://u:p@localhost:5432/foot_repose_test/'],
    ['a query string', 'postgres://u:p@localhost:5432/foot_repose_test?sslmode=require'],
    ['a percent-encoded name', 'postgres://u:p@localhost:5432/foot%5Frepose%5Ftest'],
    ['different credentials', 'postgres://other:secret@localhost:5432/foot_repose_test'],
    ['all of them at once', 'postgresql://x@LOCALHOST./foot%5Frepose%5Ftest/?a=1'],
  ])('%s is the same database', (_label, variant) => {
    expect(databaseIdentity(variant)).toBe(databaseIdentity(CANONICAL));
    // ...and the guard therefore refuses it. The omitted-port case is the one
    // that actually got through: `url.host` carries a port only when it is
    // written down, so `localhost/db` and `localhost:5432/db` compared unequal
    // and the audit was cleared to wipe the suite's database.
    expect(() =>
      resolveAuditDatabaseUrl({
        [AUDIT_DATABASE_VAR]: variant,
        TEST_DATABASE_URL: CANONICAL,
      }),
    ).toThrow(AuditDatabaseError);
  });

  it.each([
    ['a different database name', 'postgres://u:p@localhost:5432/foot_repose_audit_local'],
    ['a different port', 'postgres://u:p@localhost:5433/foot_repose_test'],
    ['a different host', 'postgres://u:p@db.internal:5432/foot_repose_test'],
  ])('%s is genuinely different and is accepted', (_label, other) => {
    expect(databaseIdentity(other)).not.toBe(databaseIdentity(CANONICAL));
    expect(
      resolveAuditDatabaseUrl({ [AUDIT_DATABASE_VAR]: other, TEST_DATABASE_URL: CANONICAL }),
    ).toBe(other);
  });

  it('does not pretend to resolve host aliases', () => {
    // Documented limit, asserted so it cannot be mistaken for a guarantee:
    // proving localhost and 127.0.0.1 are one host needs resolution in the
    // environment the audit will run in, which this cannot do.
    expect(databaseIdentity('postgres://u@127.0.0.1:5432/db')).not.toBe(
      databaseIdentity('postgres://u@localhost:5432/db'),
    );
  });

  it.each([
    ['not-a-url', /valid PostgreSQL connection URL/],
    ['mysql://u:p@localhost:3306/db', /postgres: or postgresql:/],
    ['http://localhost:5432/db', /postgres: or postgresql:/],
    ['postgres://u:p@localhost:5432', /names no database/],
    ['postgres://u:p@localhost:5432/', /names no database/],
  ])('refuses %s before anything can be wiped', (bad, expected) => {
    expect(() => databaseIdentity(bad)).toThrow(expected);
    expect(() => resolveAuditDatabaseUrl({ [AUDIT_DATABASE_VAR]: bad })).toThrow(expected);
  });
});

describe('per-weekday branch stability is asserted, not observed', () => {
  const map = (khw: number) => ({ AMR: 11, KHW: khw, RUW: 11 });

  it('accepts a weekday whose every occurrence agrees', () => {
    const { failures, canonicalByWeekday } = checkWeekdayBranchStability([
      { date: '2026-12-07', weekday: 'Monday', byBranch: map(11) },
      { date: '2026-12-14', weekday: 'Monday', byBranch: map(11) },
      // Same map, keys in a different order — canonicalisation must see through it.
      { date: '2026-12-21', weekday: 'Monday', byBranch: { RUW: 11, KHW: 11, AMR: 11 } },
    ]);
    expect(failures).toEqual([]);
    expect(canonicalByWeekday.Monday).toEqual(map(11));
  });

  it('rejects two occurrences of one weekday with different maps', () => {
    // The falsification: before this check existed the script exited zero here
    // and the report said "one distinct map per weekday".
    const { failures, canonicalByWeekday } = checkWeekdayBranchStability([
      { date: '2026-12-07', weekday: 'Monday', byBranch: map(11) },
      { date: '2026-12-14', weekday: 'Monday', byBranch: map(9) },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('Monday produced 2 different byBranch maps');
    expect(failures[0]).toContain('2026-12-07');
    expect(failures[0]).toContain('2026-12-14');
    expect(canonicalByWeekday.Monday).toBeUndefined();
  });

  it.each(['Friday', 'Saturday'])('names %s explicitly when it disagrees', (weekday) => {
    const { failures } = checkWeekdayBranchStability([
      { date: '2026-12-04', weekday, byBranch: map(5) },
      { date: '2026-12-11', weekday, byBranch: map(6) },
    ]);
    // Once from the general loop, once by name — the second is what makes a
    // regression in these two unmissable.
    expect(failures.filter((f) => f.includes(weekday))).toHaveLength(2);
    expect(failures).toContain(`${weekday} maps disagree across its occurrences`);
  });
});
