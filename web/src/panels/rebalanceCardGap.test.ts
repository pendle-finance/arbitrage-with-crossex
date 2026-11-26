import { describe, expect, it } from 'vitest';
import type { CrossexPosition, RebalanceJob } from '../api/types';
import { abandonedGapText } from './rebalanceCardGap';

const HL_ETH = 'HYPERLIQUID_FUTURE_ETH_USDC';
const GATE_ETH = 'GATE_FUTURE_ETH_USDT';
const LIGHTER_ETH = 'LIGHTER_FUTURE_ETH_USDC';

const jobWithGap = (q: number): RebalanceJob =>
  ({
    status: 'done',
    steps: [],
    openGaps: [
      {
        leg: { symbol: GATE_ETH, base: 'ETH', exchange: 'GATE', side: 'LONG', positionQty: 66, hedge: 'HYPERLIQUID' },
        qty: q,
        hedges: [{ symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'SHORT', qty: 66 }],
      },
    ],
  }) as unknown as RebalanceJob;

const position = (symbol: string, qty: number): CrossexPosition => ({ symbol, positionQty: String(qty) }) as CrossexPosition;

describe('the card gap counts only the stored hedge', () => {
  it.each([0.0166, 2_000])('the pair evened plus a Lighter short of 500 gives no gap; the pair uneven still gives the gap, %d ETH', (q) => {
    const evened = [position(HL_ETH, -(33 + q)), position(GATE_ETH, 33 + q), position(LIGHTER_ETH, -500)];
    const uneven = [position(HL_ETH, -(33 + q)), position(GATE_ETH, 33), position(LIGHTER_ETH, -500)];

    expect(abandonedGapText(jobWithGap(q), evened)).toBeNull();
    expect(abandonedGapText(jobWithGap(q), uneven)).toContain('not reopened');
  });
});
