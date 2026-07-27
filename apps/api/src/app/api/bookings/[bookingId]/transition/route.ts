import { transitionRequestSchema } from '@foot-repose/contracts';
import {
  assertTrustedOrigin,
  assertUuid,
  clientIp,
  handle,
  jsonResponse,
  parseJsonBody,
} from '../../../../../lib/http';
import { requireAuth } from '../../../../../lib/session';
import { transitionBooking } from '../../../../../modules/bookings/service';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ bookingId: string }> },
): Promise<Response> {
  return handle(async () => {
    assertTrustedOrigin(req);
    const auth = await requireAuth(req);
    const { bookingId } = await ctx.params;
    assertUuid(bookingId, 'Booking');
    const { action } = await parseJsonBody(req, transitionRequestSchema);
    const booking = await transitionBooking(auth.actor, bookingId, action, clientIp(req));
    return jsonResponse({ booking });
  });
}
