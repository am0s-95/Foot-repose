import { handle, jsonResponse } from '../../../lib/http';
import { getPool } from '../../../lib/pool';

export async function GET(): Promise<Response> {
  return handle(async () => {
    await getPool().query('SELECT 1');
    return jsonResponse({ ok: true });
  });
}
