/**
 * The Omani rial has three decimal places: 1 OMR = 1000 baisa. All amounts
 * are stored and passed around as integer baisa so money never touches
 * floating point.
 */
export const CURRENCY = 'OMR';
export const BAISA_PER_RIAL = 1000;

export function formatOmr(priceBaisa: number): string {
  if (!Number.isInteger(priceBaisa) || priceBaisa < 0) {
    throw new RangeError(`invalid baisa amount: ${priceBaisa}`);
  }
  const rials = Math.floor(priceBaisa / BAISA_PER_RIAL);
  const baisa = priceBaisa % BAISA_PER_RIAL;
  return `OMR ${rials.toLocaleString('en-US')}.${String(baisa).padStart(3, '0')}`;
}
