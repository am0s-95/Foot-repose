import { SignJWT, jwtVerify } from 'jose';
import type { Actor } from '@foot-repose/domain';
import {
  findEmployeeById,
  listActiveBranches,
  listBranchesByIds,
  type BranchRecord,
  type EmployeeRecord,
} from '@foot-repose/db';
import type { BranchSummary, EmployeeProfile } from '@foot-repose/contracts';
import { env } from './env';
import { getPool } from './pool';
import { HttpError } from './http';

export const SESSION_COOKIE = 'fr_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const secretKey = (): Uint8Array => new TextEncoder().encode(env.authSecret);

export async function createSessionToken(employeeId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(employeeId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export const clearedSessionCookie = (): string => sessionCookie('', 0);

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

export interface AuthContext {
  actor: Actor;
  employee: EmployeeRecord;
  /** Branches the employee may operate on (all active ones for super_admin). */
  branches: BranchRecord[];
}

export async function loadAuthContext(employeeId: string): Promise<AuthContext | null> {
  const pool = getPool();
  const employee = await findEmployeeById(pool, employeeId);
  if (!employee || !employee.isActive) return null;
  const branches =
    employee.role === 'super_admin'
      ? await listActiveBranches(pool)
      : await listBranchesByIds(pool, employee.branchIds);
  return {
    actor: { employeeId: employee.id, role: employee.role, branchIds: employee.branchIds },
    employee,
    branches,
  };
}

/** Resolve the session cookie to a live employee. Re-reads the employee on
 * every request so deactivation takes effect immediately. */
export async function getAuthContext(req: Request): Promise<AuthContext | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const employeeId = await verifySessionToken(token);
  if (!employeeId) return null;
  return loadAuthContext(employeeId);
}

export async function requireAuth(req: Request): Promise<AuthContext> {
  const auth = await getAuthContext(req);
  if (!auth) throw new HttpError(401, 'unauthorized', 'Authentication required');
  return auth;
}

export function toBranchSummary(branch: BranchRecord): BranchSummary {
  return { id: branch.id, code: branch.code, name: branch.name, area: branch.area };
}

export function toProfile(auth: AuthContext): EmployeeProfile {
  return {
    employee: {
      id: auth.employee.id,
      email: auth.employee.email,
      fullName: auth.employee.fullName,
      role: auth.employee.role,
    },
    branches: auth.branches.map(toBranchSummary),
  };
}
