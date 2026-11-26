import { describe, expect, it } from 'vitest';
import '../i18n';
import { feeAmount, feeText } from './previewBits';

const fees = (est: { taker?: number; maker?: number }) => ({ makerRate: 0.0002, takerRate: 0.0005, specialOverride: false, quote: 'USDT', est });

describe('ticket fee text at $6M', () => {
  it('groups a taker fee of 2866.53 USDT as 2,866.53', () => {
    expect(feeAmount(fees({ taker: 2866.53 }))).toBe('2,866.53 USDT');
    expect(feeText(fees({ taker: 2866.53 }))).toContain('2,866.53');
  });

  it('groups both ends of a maker to taker range', () => {
    expect(feeAmount(fees({ maker: 1146.91, taker: 2866.53 }))).toBe('1,146.91–2,866.53 USDT');
  });

  it('keeps a small fee as it was', () => {
    expect(feeAmount(fees({ taker: 0.0488 }))).toBe('0.0488 USDT');
  });
});
