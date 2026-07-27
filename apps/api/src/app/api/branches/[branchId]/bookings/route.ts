import { bookingsQuerySchema } from '@foot-repose/contracts';
import { assertUuid, handle, jsonResponse, parseQuery } from '../../../../../lib/http';
import { requireAuth } from '../../../../../lib/session';
import { listBranchDayBookings } from '../../../../../modules/bookings/service';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ branchId: string }> },
): Promise<Response> {
  return handle(async () => {
    const auth = await requireAuth(req);
    const { branchId } = await ctx.params;
    assertUuid(branchId, 'Branch');
    const query = parseQuery(req, bookingsQuerySchema, ['date', 'status', 'q']);
    return jsonResponse(await listBranchDayBookings(auth.actor, auth.branches, branchId, query));
  });
}
