import type { Queryable } from '../client';

export interface AuditEntry {
  actorEmployeeId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  branchId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function insertAuditLog(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs
       (actor_employee_id, action, entity_type, entity_id, branch_id, from_status, to_status, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.actorEmployeeId,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.branchId ?? null,
      entry.fromStatus ?? null,
      entry.toStatus ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.ip ?? null,
    ],
  );
}
