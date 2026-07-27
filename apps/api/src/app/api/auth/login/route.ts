import { loginRequestSchema } from '@foot-repose/contracts';
import {
  assertTrustedOrigin,
  clientIp,
  handle,
  HttpError,
  jsonWithCookie,
  parseJsonBody,
} from '../../../../lib/http';
import {
  createEmployeeSession,
  loadAuthContext,
  sessionCookie,
  toProfile,
} from '../../../../lib/session';
import { login } from '../../../../modules/auth/service';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertTrustedOrigin(req);
    const { email, password } = await parseJsonBody(req, loginRequestSchema);
    const ip = clientIp(req);
    const outcome = await login(email, password, ip);
    if (outcome.status === 'rate_limited') {
      throw new HttpError(429, 'rate_limited', 'Too many failed attempts — try again later');
    }
    if (outcome.status === 'invalid') {
      throw new HttpError(401, 'unauthorized', 'Invalid email or password');
    }
    const auth = await loadAuthContext(outcome.employeeId);
    if (!auth) throw new HttpError(401, 'unauthorized', 'Invalid email or password');
    const token = await createEmployeeSession(outcome.employeeId, ip);
    return jsonWithCookie(toProfile(auth), sessionCookie(token));
  });
}
