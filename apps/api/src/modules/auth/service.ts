import bcrypt from 'bcryptjs';
import { findEmployeeByEmail, insertAuditLog } from '@foot-repose/db';
import { getPool } from '../../lib/pool';

/** Burn comparable time when the email is unknown (no user enumeration). */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/**
 * Verify credentials. Every attempt — success or failure — is written to the
 * audit log. Returns the employee id on success, null otherwise.
 */
export async function verifyLogin(
  email: string,
  password: string,
  ip: string | null,
): Promise<string | null> {
  const pool = getPool();
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
    return null;
  }
  await insertAuditLog(pool, {
    actorEmployeeId: employee.id,
    action: 'auth.login',
    entityType: 'employee',
    entityId: employee.id,
    ip,
  });
  return employee.id;
}
