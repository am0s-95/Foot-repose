import { describe, expect, it } from 'vitest';
import { isTestDatabaseName } from '../src/testing';

/**
 * Pure unit coverage of the exact-suffix rule, including the literal
 * dangerous names — no database is ever created or dropped for these.
 */
describe('isTestDatabaseName (exact _test suffix)', () => {
  it('accepts only names ending exactly with _test', () => {
    expect(isTestDatabaseName('foot_repose_test')).toBe(true);
    expect(isTestDatabaseName('anything_else_test')).toBe(true);
  });

  it('rejects production and near-miss names', () => {
    expect(isTestDatabaseName('foot_repose_prod')).toBe(false);
    expect(isTestDatabaseName('foot_repose_production')).toBe(false);
    expect(isTestDatabaseName('foot_repose_test_backup')).toBe(false);
    expect(isTestDatabaseName('foot_repose_dev')).toBe(false);
    expect(isTestDatabaseName('foot_repose_testing')).toBe(false);
    expect(isTestDatabaseName('test')).toBe(false);
  });
});
