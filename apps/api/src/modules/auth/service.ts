import bcrypt from 'bcryptjs';
import {
  createSession,
  findEmployeeByEmail,
  insertAuditLog,
  withTransaction,
} from '@foot-repose/db';
import { getPool } from '../../lib/pool';
import { SESSION_TTL_SECONDS } from '../../lib/session';
import { clearLoginFailures, loginRateLimitKey, registerLoginAttempt } from './rate-limit';

/** Burn comparable time when the email is unknown (no user enumeration). */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export type LoginOutcome =
  | { status: 'ok'; employeeId: string; sessionId: string }
  | { status: 'invalid' }
  | { status: 'rate_limited' };

/**
 * Verify credentials with shared rate limiting. Every attempt — success,
 * failure or throttle — is written to the audit log. On success the session
 * row and its audit entry are created in ONE transaction.
 */
export async function login(email: string, password: string, ip: string | null): Promise<LoginOutcome> {
  const pool = getPool();
  const key = loginRateLimitKey(email, ip);

  const { limited } = await registerLoginAttempt(key);
  if (limited) {
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

  // Session row + login audit commit or roll back together.
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const sessionId = await withTransaction(pool, async (tx) => {
    const id = await createSession(tx, { employeeId: employee.id, expiresAt, ip });
    await insertAuditLog(tx, {
      actorEmployeeId: employee.id,
      action: 'auth.login',
      entityType: 'employee',
      entityId: employee.id,
      ip,
    });
    return id;
  });
  await clearLoginFailures(key);
  return { status: 'ok', employeeId: employee.id, sessionId };
}
