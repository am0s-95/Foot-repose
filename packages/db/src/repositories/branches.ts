import type { Queryable } from '../client';

export interface BranchRecord {
  id: string;
  code: string;
  name: string;
  area: string;
  phone: string;
  isActive: boolean;
}

interface BranchRow {
  id: string;
  code: string;
  name: string;
  area: string;
  phone: string;
  is_active: boolean;
}

const BRANCH_SELECT = 'SELECT id, code, name, area, phone, is_active FROM branches';

function toRecord(row: BranchRow): BranchRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    area: row.area,
    phone: row.phone,
    isActive: row.is_active,
  };
}

export async function listActiveBranches(db: Queryable): Promise<BranchRecord[]> {
  const result = await db.query<BranchRow>(`${BRANCH_SELECT} WHERE is_active ORDER BY name`);
  return result.rows.map(toRecord);
}

/**
 * Read the branch's active flag under FOR SHARE inside the caller's
 * transaction: a concurrent deactivation (row UPDATE) either committed
 * before us — we see false — or must wait until our transaction commits.
 */
export async function lockBranchIsActive(db: Queryable, branchId: string): Promise<boolean | null> {
  const result = await db.query<{ is_active: boolean }>(
    'SELECT is_active FROM branches WHERE id = $1 FOR SHARE',
    [branchId],
  );
  return result.rows[0]?.is_active ?? null;
}

export async function listBranchesByIds(db: Queryable, ids: readonly string[]): Promise<BranchRecord[]> {
  if (ids.length === 0) return [];
  const result = await db.query<BranchRow>(
    `${BRANCH_SELECT} WHERE id = ANY($1) AND is_active ORDER BY name`,
    [ids as string[]],
  );
  return result.rows.map(toRecord);
}
