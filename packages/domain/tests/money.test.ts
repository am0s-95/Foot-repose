import { describe, expect, it } from 'vitest';
import { formatOmr } from '../src/index';

describe('formatOmr', () => {
  it('formats baisa with three decimals', () => {
    expect(formatOmr(0)).toBe('OMR 0.000');
    expect(formatOmr(500)).toBe('OMR 0.500');
    expect(formatOmr(8500)).toBe('OMR 8.500');
    expect(formatOmr(14000)).toBe('OMR 14.000');
    expect(formatOmr(1234567)).toBe('OMR 1,234.567');
  });

  it('rejects fractional or negative amounts', () => {
    expect(() => formatOmr(12.5)).toThrow(RangeError);
    expect(() => formatOmr(-1)).toThrow(RangeError);
    expect(() => formatOmr(Number.NaN)).toThrow(RangeError);
  });
});
