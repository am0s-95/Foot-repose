import bcrypt from 'bcryptjs';
import { findEmployeeByEmail, insertAuditLog } from '@foot-repose/db';
import { getPool } from '../../lib/pool';
import {
  clearLoginFailures,
  isLoginRateLimited,
  loginRateLimitKey,
  recordFailedLogin,
} from './rate-limit';

/** Burn comparable time when the email is unknown (no user enumeration). */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export type LoginOutcome =
  | { status: 'ok'; employeeId: string }
  | { status: 'invalid' }
  | { status: 'rate_limited' };

/**
 * Verify credentials with rate limiting. Every attempt — success, failure or
 * throttle — is written to the audit log.
 */
export async function login(email: string, password: string, ip: string | null): Promise<LoginOutcome> {
  const pool = getPool();
  const key = loginRateLimitKey(email, ip);

  if (isLoginRateLimited(key)) {
    await insertAuditLog(pool, {
      actorEmployeeId: null,
      action: 'auth.login_rate_limited',
      entityType: 'employee',
      metadata: { email },
      ip,
    });
    return { status: 'rate_limited' };
  }

  const employee = await findEmployeeByEmail(pool, email);
  // ponytail: compareSync is fine at staff-login volume; switch to async if it ever shows up in latency
  const passwordOk = bcrypt.compareSync(password, employee?.passwordHash ?? DUMMY_HASH);
  if (!employee || !passwordOk || !employee.isActive) {
    recordFailedLogin(key);
    await insertAuditLog(pool, {
      actorEmployeeId: employee?.id ?? null,
      action: 'auth.login_failed',
      entityType: 'employee',
      entityId: employee?.id ?? null,
      metadata: { email },
      ip,
    });
    return { status: 'invalid' };
  }

  clearLoginFailures(key);
  await insertAuditLog(pool, {
    actorEmployeeId: employee.id,
    action: 'auth.login',
    entityType: 'employee',
    entityId: employee.id,
    ip,
  });
  return { status: 'ok', employeeId: employee.id };
}
