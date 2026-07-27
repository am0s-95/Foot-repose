import { insertAuditLog, revokeSession, withTransaction } from '@foot-repose/db';
import { assertTrustedOrigin, clientIp, handle, jsonWithCookie } from '../../../../lib/http';
import { clearedSessionCookie, getAuthContext } from '../../../../lib/session';
import { getPool } from '../../../../lib/pool';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertTrustedOrigin(req);
    const auth = await getAuthContext(req);
    if (auth?.sessionId) {
      const sessionId = auth.sessionId;
      // Revocation and its audit entry commit or roll back together.
      await withTransaction(getPool(), async (tx) => {
        await revokeSession(tx, sessionId);
        await insertAuditLog(tx, {
          actorEmployeeId: auth.employee.id,
          action: 'auth.logout',
          entityType: 'employee',
          entityId: auth.employee.id,
          ip: clientIp(req),
        });
      });
    }
    return jsonWithCookie({ ok: true }, clearedSessionCookie());
  });
}
