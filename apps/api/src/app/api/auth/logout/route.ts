import { insertAuditLog } from '@foot-repose/db';
import { clientIp, handle, jsonWithCookie } from '../../../../lib/http';
import { clearedSessionCookie, getAuthContext } from '../../../../lib/session';
import { getPool } from '../../../../lib/pool';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const auth = await getAuthContext(req);
    if (auth) {
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
