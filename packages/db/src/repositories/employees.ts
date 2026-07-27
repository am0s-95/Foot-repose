import type { EmployeeRole } from '@foot-repose/domain';
import type { Queryable } from '../client';

export interface EmployeeRecord {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  role: EmployeeRole;
  isActive: boolean;
  branchIds: string[];
}

interface EmployeeRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: EmployeeRole;
  is_active: boolean;
  branch_ids: string[] | null;
}

const EMPLOYEE_SELECT = `
  SELECT e.id, e.email, e.password_hash, e.full_name, e.role, e.is_active,
         array_remove(array_agg(eb.branch_id), NULL) AS branch_ids
  FROM employees e
  LEFT JOIN employee_branches eb ON eb.employee_id = e.id
`;

function toRecord(row: EmployeeRow): EmployeeRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active,
    branchIds: row.branch_ids ?? [],
  };
}

export async function findEmployeeByEmail(
  db: Queryable,
  email: string,
): Promise<EmployeeRecord | null> {
  const result = await db.query<EmployeeRow>(`${EMPLOYEE_SELECT} WHERE e.email = $1 GROUP BY e.id`, [
    email.toLowerCase(),
  ]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function findEmployeeById(db: Queryable, id: string): Promise<EmployeeRecord | null> {
  const result = await db.query<EmployeeRow>(`${EMPLOYEE_SELECT} WHERE e.id = $1 GROUP BY e.id`, [
    id,
  ]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}
