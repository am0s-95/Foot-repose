import { SignJWT, jwtVerify } from 'jose';
import type { Actor } from '@foot-repose/domain';
import {
  findActiveSession,
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

/**
 * WORKFORCE realm session cookie (employees only). The future customer realm
 * gets its own cookie, principal table and session store — never share them.
 */
export const SESSION_COOKIE = 'fr_wf_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const secretKey = (): Uint8Array => new TextEncoder().encode(env.authSecret);

/** Sign a JWT referencing an existing sessions row (created transactionally
 * by the auth service). Revoking the row invalidates the token no matter
 * what the client still holds. */
export async function signSessionToken(employeeId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(employeeId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

export interface SessionClaims {
  employeeId: string;
  sessionId: string;
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { employeeId: payload.sub, sessionId: payload.sid };
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
  /** Server-side session row backing this request (null right after login,
   * before the cookie round-trips). */
  sessionId: string | null;
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
    sessionId: null,
  };
}

/** Resolve the session cookie to a live employee. The JWT alone is not
 * enough: the server-side session row must exist, be un-revoked and
 * un-expired, and the employee must still be active. */
export async function getAuthContext(req: Request): Promise<AuthContext | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const claims = await verifySessionToken(token);
  if (!claims) return null;
  const session = await findActiveSession(getPool(), claims.sessionId, claims.employeeId);
  if (!session) return null;
  const auth = await loadAuthContext(claims.employeeId);
  if (!auth) return null;
  return { ...auth, sessionId: session.id };
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
