import { loginRequestSchema } from '@foot-repose/contracts';
import {
  assertTrustedOrigin,
  handle,
  HttpError,
  jsonWithCookie,
  parseJsonBody,
  trustedClientIp,
} from '../../../../lib/http';
import {
  loadAuthContext,
  sessionCookie,
  signSessionToken,
  toProfile,
} from '../../../../lib/session';
import { login } from '../../../../modules/auth/service';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertTrustedOrigin(req);
    const { email, password } = await parseJsonBody(req, loginRequestSchema);
    const ip = trustedClientIp(req);
    const outcome = await login(email, password, ip);
    // Throttling and verification saturation answer IDENTICALLY: same status,
    // same code, same message. Only the audit log distinguishes them, so the
    // response cannot be used to probe either the account or the server's load.
    if (outcome.status === 'rate_limited' || outcome.status === 'overloaded') {
      throw new HttpError(429, 'rate_limited', 'Too many failed attempts — try again later');
    }
    if (outcome.status === 'invalid') {
      throw new HttpError(401, 'unauthorized', 'Invalid email or password');
    }
    const auth = await loadAuthContext(outcome.employeeId);
    if (!auth) throw new HttpError(401, 'unauthorized', 'Invalid email or password');
    const token = await signSessionToken(outcome.employeeId, outcome.sessionId);
    return jsonWithCookie(toProfile(auth), sessionCookie(token));
  });
}
