import { listActiveBranches } from '@foot-repose/db';
import { handle, jsonResponse } from '../../../../lib/http';
import { getPool } from '../../../../lib/pool';

/** Public branch directory (used by the customer app). No auth, no PII. */
export async function GET(): Promise<Response> {
  return handle(async () => {
    const branches = await listActiveBranches(getPool());
    return jsonResponse(
      {
        branches: branches.map((branch) => ({
          id: branch.id,
          code: branch.code,
          name: branch.name,
          area: branch.area,
          phone: branch.phone,
        })),
      },
      { headers: { 'cache-control': 'public, max-age=300' } },
    );
  });
}
