import { insertAuditLog, revokeSession } from '@foot-repose/db';
import { assertTrustedOrigin, clientIp, handle, jsonWithCookie } from '../../../../lib/http';
import { clearedSessionCookie, getAuthContext } from '../../../../lib/session';
import { getPool } from '../../../../lib/pool';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertTrustedOrigin(req);
    const auth = await getAuthContext(req);
    if (auth) {
      // Revoke server-side first: the token is dead even if the client keeps it.
      if (auth.sessionId) await revokeSession(getPool(), auth.sessionId);
      await insertAuditLog(getPool(), {
        actorEmployeeId: auth.employee.id,
        action: 'auth.logout',
        entityType: 'employee',
        entityId: auth.employee.id,
        ip: clientIp(req),
      });
    }
    return jsonWithCookie({ ok: true }, clearedSessionCookie());
  });
}
