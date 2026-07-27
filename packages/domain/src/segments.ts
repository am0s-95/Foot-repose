/** Which customers a branch serves. NULL in the database means "not yet
 * classified" — real branch classifications are business data, never guessed
 * in code or migrations. */
export const CUSTOMER_SEGMENTS = ['men', 'women', 'mixed'] as const;

export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];

export function isCustomerSegment(value: string): value is CustomerSegment {
  return (CUSTOMER_SEGMENTS as readonly string[]).includes(value);
}
