import type { Queryable } from '../client';

export interface SessionRecord {
  id: string;
  employeeId: string;
}

export async function createSession(
  db: Queryable,
  input: { employeeId: string; expiresAt: Date; ip: string | null },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    'INSERT INTO sessions (employee_id, expires_at, ip) VALUES ($1, $2, $3) RETURNING id',
    [input.employeeId, input.expiresAt, input.ip],
  );
  return result.rows[0]!.id;
}

/** A session is live only while un-revoked and un-expired. */
export async function findActiveSession(
  db: Queryable,
  sessionId: string,
  employeeId: string,
): Promise<SessionRecord | null> {
  const result = await db.query<{ id: string; employee_id: string }>(
    `SELECT id, employee_id FROM sessions
     WHERE id = $1 AND employee_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [sessionId, employeeId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, employeeId: row.employee_id } : null;
}

export async function revokeSession(db: Queryable, sessionId: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
  );
  return result.rowCount === 1;
}
