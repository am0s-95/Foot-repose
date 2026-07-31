import { describe, expect, it } from 'vitest';
import {
  AUDIT_DATABASE_VAR,
  AuditDatabaseError,
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
