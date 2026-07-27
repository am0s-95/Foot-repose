import { handle, jsonResponse } from '../../../../lib/http';
import { requireAuth, toProfile } from '../../../../lib/session';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => jsonResponse(toProfile(await requireAuth(req))));
}
