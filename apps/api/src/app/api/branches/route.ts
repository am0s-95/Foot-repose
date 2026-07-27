import { handle, jsonResponse } from '../../../lib/http';
import { requireAuth, toBranchSummary } from '../../../lib/session';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const auth = await requireAuth(req);
    return jsonResponse({ branches: auth.branches.map(toBranchSummary) });
  });
}
