import {
  createSession,
  findEmployeeByEmail,
  insertAuditLog,
  withTransaction,
} from '@foot-repose/db';
import { getPool } from '../../lib/pool';
import { SESSION_TTL_SECONDS } from '../../lib/session';
import { verifyPassword, VerificationOverloadError } from './password';
import { clearLoginFailures, registerLoginAttempt } from './rate-limit';

export type LoginOutcome =
  | { status: 'ok'; employeeId: string; sessionId: string }
  | { status: 'invalid' }
  | { status: 'rate_limited' }
  /** Verification capacity is saturated. Answered like throttling on the wire so
   * it reveals nothing about the account. */
  | { status: 'overloaded' };

/**
 * Verify credentials with shared rate limiting. Every attempt — success,
 * failure, throttle or refusal — is written to the audit log. On success the
 * session row and its audit entry are created in ONE transaction.
 *
 * `ip` is the AUTHORITATIVE client address or null; it is never a forwarded
 * header taken on trust. Rate limiting keys on the normalized email regardless,
 * so a null address weakens nothing about the mandatory bucket.
 */
export async function login(
  email: string,
  password: string,
  ip: string | null,
): Promise<LoginOutcome> {
  const pool = getPool();

  const { limited, dimension } = await registerLoginAttempt(email, ip);
  if (limited) {
    await insertAuditLog(pool, {
      actorEmployeeId: null,
      action: 'auth.login_rate_limited',
      entityType: 'employee',
      metadata: { email, dimension },
      ip,
    });
    // Note the ordering: a throttled attempt returns BEFORE any password
    // verification, so the cheap control gates the expensive work rather than
    // the other way round.
    return { status: 'rate_limited' };
  }

  const employee = await findEmployeeByEmail(pool, email);

  let passwordOk: boolean;
  try {
    passwordOk = await verifyPassword(password, employee?.passwordHash ?? null);
  } catch (error) {
    if (!(error instanceof VerificationOverloadError)) throw error;
    // Recorded so operators can tell saturation from throttling; the caller
    // cannot, because both answer 429 with the same body.
    await insertAuditLog(pool, {
      actorEmployeeId: null,
      action: 'auth.login_verification_rejected',
      entityType: 'employee',
      metadata: { email },
      ip,
    });
    return { status: 'overloaded' };
  }

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
  await clearLoginFailures(email);
  return { status: 'ok', employeeId: employee.id, sessionId };
}
