import { loginRequestSchema } from '@foot-repose/contracts';
import { clientIp, handle, HttpError, jsonWithCookie, parseJsonBody } from '../../../../lib/http';
import {
  createSessionToken,
  loadAuthContext,
  sessionCookie,
  toProfile,
} from '../../../../lib/session';
import { verifyLogin } from '../../../../modules/auth/service';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const { email, password } = await parseJsonBody(req, loginRequestSchema);
    const employeeId = await verifyLogin(email, password, clientIp(req));
    if (!employeeId) throw new HttpError(401, 'unauthorized', 'Invalid email or password');
    const auth = await loadAuthContext(employeeId);
    if (!auth) throw new HttpError(401, 'unauthorized', 'Invalid email or password');
    const token = await createSessionToken(employeeId);
    return jsonWithCookie(toProfile(auth), sessionCookie(token));
  });
}
