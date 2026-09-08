import { describe, expect, it } from 'vitest';
import type { CrossexAccount, CrossexPosition, ExposureGroup, PositionsResponse } from '../api/types';
import { describeLine, fmtLinePrice, fmtMove, lineFor, lineLabel, liquidationLines, nearestLiquidation } from './liquidation';

/** The lines of a view the model could price. */
const lines = (...args: Parameters<typeof liquidationLines>) => liquidationLines(...args)!.lines;

const position = (symbol: string, over: Partial<CrossexPosition> = {}): CrossexPosition => ({
  symbol,
  positionSide: 'NONE',
  positionQty: '0',
  positionValue: '0',
  entryPrice: '0',
  markPrice: '0',
  leverage: '25',
  maxLeverage: '50',
  upnl: '0',
  upnlRate: '0',
  fundingFee: '0',
  fee: '0',
  initialMargin: '0',
  maintenanceMargin: '0',
  ...over,
});

const group = (base: string, legs: ExposureGroup['legs']): ExposureGroup => {
  const longValue = legs.filter((l) => l.side === 'LONG').reduce((s, l) => s + l.value, 0);
  const shortValue = legs.filter((l) => l.side === 'SHORT').reduce((s, l) => s + l.value, 0);
  return {
    base,
    legs,
    longValue,
    shortValue,
    netValue: longValue - shortValue,
    grossValue: longValue + shortValue,
    neutral: Math.abs(longValue - shortValue) / (longValue + shortValue) < 0.02,
    singleLeg: longValue === 0 || shortValue === 0,
  };
};

const account = (over: Partial<CrossexAccount> = {}): CrossexAccount => ({
  marginBalance: '20000',
  availableMargin: '15000',
  initialMargin: '5000',
  maintenanceMargin: '2500',
  initialMarginRate: '4',
  maintenanceMarginRate: '8',
  accountMode: 'CROSS',
  positionMode: 'ONE_WAY',
  assets: [
    { coin: 'USDT', exchangeType: 'CROSSEX', balance: '20000', equity: '20000', availableBalance: '20000', upnl: '0', liability: '0' },
    { coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '0', equity: '0', availableBalance: '0', upnl: '0', liability: '0' },
  ],
  ...over,
});

/** The report's worked example: $20k capital, $250k a leg, ETH at $2,300,
 * short on Hyperliquid, long on Gate, 0.5% maintenance on each leg. */
const box = (): PositionsResponse => ({
  positions: [
    position('GATE_FUTURE_ETH_USDT', { positionQty: '108.7', positionValue: '250000', markPrice: '2300', maintenanceMargin: '1250' }),
    position('HYPERLIQUID_FUTURE_ETH_USDC', { positionQty: '-108.7', positionValue: '250000', markPrice: '2300', maintenanceMargin: '1250' }),
  ],
  exposure: [
    group('ETH', [
      { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 108.7, value: 250000 },
      { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 108.7, value: 250000 },
    ]),
  ],
});

describe('liquidationLines', () => {
  it('finds the pump that liquidates a hedged box with the short on Hyperliquid', () => {
    // Margin balance is flat. Maintenance grows 2500 per 1x of move from the
    // legs and 25,000 per 1x from the borrow (10% of the Hyperliquid loss):
    // 20000 = 2500 f + 25000 (f - 1)  →  f = 45000 / 27500.
    const [line] = lines(account(), box());
    expect(line.base).toBe('ETH');
    expect(line.move).toBeCloseTo(45000 / 27500 - 1, 4);
    expect(line.price).toBeCloseTo(2300 * (45000 / 27500), 2);
  });

  it('moves the line out when cash is shifted into the Hyperliquid USDC wallet', () => {
    // 20k of USDC cover absorbs the first 20k of loss before any borrow:
    // 20000 = 2500 f + 0.1 (250000 (f - 1) - 20000)  →  f = 47000 / 27500.
    const [line] = lines(account(), box(), { 'USDC/HYPERLIQUID': 20000, 'USDT/CROSSEX': -20000 });
    expect(line.move).toBeCloseTo(47000 / 27500 - 1, 4);
  });

  it('with the Hyperliquid leg long, both directions borrow, and the nearer line wins', () => {
    const flipped = box();
    flipped.exposure[0].legs[0].side = 'SHORT';
    flipped.exposure[0].legs[1].side = 'LONG';
    const [line] = lines(account(), flipped);
    // Pump: the Gate short loses, the USDT wallet spends its 20k of cash and
    // then borrows: 20000 = 2500 f + 0.1 (250000 (f - 1) - 20000) → f = 47000 / 27500, +71%.
    // Dump: the Hyperliquid long loses and its empty USDC wallet borrows from
    // the first dollar, but the legs' own maintenance shrinks with the price:
    // 20000 = 2500 f + 25000 (1 - f) → f = 5000 / 22500, -78%. The pump is nearer.
    expect(line.move).toBeCloseTo(47000 / 27500 - 1, 4);
  });

  it('finds the dump for a lone Hyperliquid long, where a pump only adds margin balance', () => {
    const lone: PositionsResponse = {
      positions: [position('HYPERLIQUID_FUTURE_ETH_USDC', { positionValue: '250000', markPrice: '2300', maintenanceMargin: '1250' })],
      exposure: [
        group('ETH', [
          { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'LONG', qty: 108.7, value: 250000 },
        ]),
      ],
    };
    const [line] = lines(account({ maintenanceMargin: '1250' }), lone);
    // 20000 - 250000 (1 - f) = 1250 f + 25000 (1 - f) → f = 255000 / 273750, a 6.9% dump.
    expect(line.move).toBeCloseTo(255000 / 273750 - 1, 4);
    expect(line.move).toBeLessThan(0);
  });

  it('puts a USDT-only pair far out: no borrow, only the legs grow', () => {
    const usdt = box();
    usdt.positions[1].symbol = 'BINANCE_FUTURE_ETH_USDT';
    usdt.exposure[0].legs[1] = { ...usdt.exposure[0].legs[1], symbol: 'BINANCE_FUTURE_ETH_USDT', exchange: 'BINANCE', quote: 'USDT' };
    const [line] = lines(account(), usdt);
    // 20000 = 2500 f  →  f = 8, a +700% pump.
    expect(line.move).toBeCloseTo(7, 4);
  });

  it('lists a coin as far past a 10x pump, prices nothing with no positions, and is unknown without margin figures', () => {
    const wide = box();
    wide.positions[1].symbol = 'BINANCE_FUTURE_ETH_USDT';
    wide.exposure[0].legs[1] = { ...wide.exposure[0].legs[1], symbol: 'BINANCE_FUTURE_ETH_USDT', exchange: 'BINANCE', quote: 'USDT' };
    const far = liquidationLines(account({ marginBalance: '30000' }), wide);
    expect(far).toEqual({ lines: [], far: ['ETH'] });
    expect(lineFor(far!, 'eth')).toBe('far');
    expect(lineFor(far!, 'HYPE')).toBeNull();
    expect(liquidationLines(account(), { positions: [], exposure: [] })).toEqual({ lines: [], far: [] });
    expect(liquidationLines(account({ marginBalance: 'n/a' }), box())).toBeNull();
    expect(liquidationLines(account({ maintenanceMargin: undefined as unknown as string }), box())).toBeNull();
    expect(nearestLiquidation(account({ marginBalance: 'n/a' }), box())).toBeNull();
    expect(nearestLiquidation(undefined, box())).toBeNull();
  });

  it('matches the live account of 2026-09-07 within a percent', () => {
    // Gate: margin balance 987.58, maintenance 61.03 (= 60.26 of positions +
    // 0.77, being 10% of the 7.66 USDC liability). ETH: long 124.58 on
    // Binance, long 1370.48 on Gate, short 1520.43 on Hyperliquid.
    const acc = account({
      marginBalance: '987.578',
      maintenanceMargin: '61.028',
      assets: [
        { coin: 'USDT', exchangeType: 'CROSSEX', balance: '990.84', equity: '995.24', availableBalance: '990.84', upnl: '4.41', liability: '0' },
        { coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '7.17', equity: '-7.66', availableBalance: '7.17', upnl: '-14.83', liability: '7.66' },
      ],
    });
    const live: PositionsResponse = {
      positions: [
        position('BINANCE_FUTURE_ETH_USDT', { positionValue: '124.5765', markPrice: '2491.53', maintenanceMargin: '0.716314875' }),
        position('GATE_FUTURE_ETH_USDT', { positionValue: '1370.4845', markPrice: '2491.79', maintenanceMargin: '14.732708375' }),
        position('HYPERLIQUID_FUTURE_ETH_USDC', { positionValue: '1520.425', markPrice: '2492.5', maintenanceMargin: '31.54881875' }),
        position('HYPERLIQUID_FUTURE_HYPE_USDC', { positionValue: '199.3801', markPrice: '86.687', maintenanceMargin: '10.118540075' }),
        position('GATE_FUTURE_HYPE_USDT', { positionValue: '199.318', markPrice: '86.66', maintenanceMargin: '3.1392585' }),
      ],
      exposure: [
        group('ETH', [
          { symbol: 'BINANCE_FUTURE_ETH_USDT', exchange: 'BINANCE', quote: 'USDT', side: 'LONG', qty: 0.05, value: 124.5765 },
          { symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 0.55, value: 1370.4845 },
          { symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 0.61, value: 1520.425 },
        ]),
        group('HYPE', [
          { symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: 2.3, value: 199.3801 },
          { symbol: 'GATE_FUTURE_HYPE_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 2.3, value: 199.318 },
        ]),
      ],
    };
    const view = liquidationLines(acc, live)!;
    // By hand: 926.55 of room, eaten at 25.37 (net short) + 47.0 (legs) +
    // 152.04 (borrow) = 224.4 per 1x of ETH  →  +4.13.
    const eth = lineFor(view, 'ETH') as { move: number; price: number };
    expect(eth.move).toBeCloseTo(4.13, 1);
    expect(eth.price).toBeCloseTo(2492.5 * 5.13, -1);
    // HYPE: 926.55 eaten at 0.06 (net) + 13.26 (legs) + 19.94 (borrow) = 33.3 per 1x → far past 10x.
    expect(lineFor(view, 'HYPE')).toBe('far');
    expect(view.far).toEqual(['HYPE']);
    expect(view.lines[0].base).toBe('ETH');
  });
});

describe('formatting', () => {
  it("writes moves as whole signed percents and prices to the coin's scale", () => {
    expect(fmtMove(0.3712)).toBe('+37%');
    expect(fmtMove(-0.2)).toBe('-20%');
    expect(fmtLinePrice(3150.4)).toBe('~$3,150');
    expect(fmtLinePrice(115.23)).toBe('~$115.23');
    expect(lineLabel({ base: 'ETH', price: 3150, move: 0.37 })).toBe('Liquidates if ETH hits ~$3,150 (+37%)');
    expect(lineLabel({ base: 'ETH', price: 1840, move: -0.2 })).toBe('Liquidates if ETH falls to ~$1,840 (-20%)');
    expect(describeLine({ base: 'ETH', price: 3150, move: 0.37 })).toBe(
      'Liquidates at about $3,150 if only ETH moves (+37%) and every other coin holds still.',
    );
  });
});
