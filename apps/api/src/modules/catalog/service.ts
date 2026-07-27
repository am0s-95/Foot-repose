import { formatOmr, isIsoDate, muscatDayUtcRange, todayInMuscat } from '@foot-repose/domain';
import { listBranchesByIds, listEffectiveOfferings, type BranchRecord } from '@foot-repose/db';
import type { BranchCatalogResponse, PublicBranch } from '@foot-repose/contracts';
import { HttpError } from '../../lib/http';
import { getPool } from '../../lib/pool';

export function toPublicBranch(branch: BranchRecord): PublicBranch {
  return {
    id: branch.id,
    code: branch.code,
    name: branch.name,
    area: branch.area,
    phone: branch.phone,
    customerSegment: branch.customerSegment,
  };
}

/**
 * The branch catalog effective on a Muscat calendar date. "Effective" is
 * evaluated at the start of that Muscat day, matching the half-open
 * [from, to) validity ranges — an offering starting on day D applies to D.
 */
export async function getBranchCatalog(
  branchId: string,
  dateParam?: string,
): Promise<BranchCatalogResponse> {
  const pool = getPool();
  const branch = (await listBranchesByIds(pool, [branchId]))[0];
  if (!branch) throw new HttpError(404, 'not_found', 'Branch not found');

  const date = dateParam ?? todayInMuscat();
  if (!isIsoDate(date)) throw new HttpError(400, 'validation_error', `Invalid date: ${date}`);
  const { startUtc } = muscatDayUtcRange(date);

  const offerings = await listEffectiveOfferings(pool, branchId, startUtc);
  return {
    branch: toPublicBranch(branch),
    date,
    services: offerings.map((offering) => ({
      serviceId: offering.serviceId,
      name: offering.serviceName,
      durationMin: offering.durationMin,
      priceBaisa: offering.priceBaisa,
      priceFormatted: formatOmr(offering.priceBaisa),
      bufferBeforeMin: offering.bufferBeforeMin,
      bufferAfterMin: offering.bufferAfterMin,
      isBookableOnline: offering.isBookableOnline,
    })),
  };
}
