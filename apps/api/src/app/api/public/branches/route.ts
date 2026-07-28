import { listActiveBranches } from '@foot-repose/db';
import { handle, jsonResponse } from '../../../../lib/http';
import { getPool } from '../../../../lib/pool';
import { toPublicBranch } from '../../../../modules/catalog/service';

/** Public branch directory (used by the customer app). No auth, no PII. */
export async function GET(): Promise<Response> {
  return handle(async () => {
    const branches = await listActiveBranches(getPool());
    return jsonResponse(
      { branches: branches.map(toPublicBranch) },
      { headers: { 'cache-control': 'public, max-age=300' } },
    );
  });
}
