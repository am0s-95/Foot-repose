import type { Queryable } from '../client';

export interface EffectiveOffering {
  serviceId: string;
  serviceName: string;
  priceBaisa: number;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  isBookableOnline: boolean;
}

interface OfferingRow {
  service_id: string;
  service_name: string;
  price_baisa: number;
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  is_bookable_online: boolean;
}

/**
 * Offerings whose validity range contains `atUtc`, for active services of
 * one branch. The exclusion constraint guarantees at most one effective row
 * per (branch, service) at any instant.
 */
export async function listEffectiveOfferings(
  db: Queryable,
  branchId: string,
  atUtc: Date,
): Promise<EffectiveOffering[]> {
  const result = await db.query<OfferingRow>(
    `SELECT o.service_id, s.name AS service_name, o.price_baisa, o.duration_min,
            o.buffer_before_min, o.buffer_after_min, o.is_bookable_online
     FROM branch_service_offerings o
     JOIN services s ON s.id = o.service_id
     WHERE o.branch_id = $1
       AND o.valid_during @> $2::timestamptz
       AND s.is_active
     ORDER BY s.name`,
    [branchId, atUtc],
  );
  return result.rows.map((row) => ({
    serviceId: row.service_id,
    serviceName: row.service_name,
    priceBaisa: row.price_baisa,
    durationMin: row.duration_min,
    bufferBeforeMin: row.buffer_before_min,
    bufferAfterMin: row.buffer_after_min,
    isBookableOnline: row.is_bookable_online,
  }));
}
