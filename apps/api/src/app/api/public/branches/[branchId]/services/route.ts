import { z } from 'zod';
import { assertUuid, handle, jsonResponse, parseQuery } from '../../../../../../lib/http';
import { getBranchCatalog } from '../../../../../../modules/catalog/service';

const querySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .optional(),
});

/** Public: a branch's effective service catalog on a Muscat date. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ branchId: string }> },
): Promise<Response> {
  return handle(async () => {
    const { branchId } = await ctx.params;
    assertUuid(branchId, 'Branch');
    const { date } = parseQuery(req, querySchema, ['date']);
    return jsonResponse(await getBranchCatalog(branchId, date), {
      headers: { 'cache-control': 'public, max-age=300' },
    });
  });
}
