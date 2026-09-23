import { describe, expect, it } from 'vitest';
import type { CrossexAccount, CrossexPosition, ExposureGroup, PositionsResponse } from '../api/types';
import {
  describeLine,
  fmtLinePrice,
  fmtMove,
  lineFor,
  lineLabel,
  liquidationLines,
  liquidationSides,
  maintenanceAt,
  unknownLabel,
  type LiquidationLine,
  type MarginTiers,
} from './liquidation';
import { whaleBook } from '../test/fixtures';

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
    expect(line.venue).toBe('Hyperliquid');
    expect(line.move).toBeCloseTo(45000 / 27500 - 1, 4);
    expect(line.price).toBeCloseTo(2300 * (45000 / 27500), 2);
  });

  it('a Lighter leg borrows in its own USDC wallet, not the USDT wallet', () => {
    const lighter = box();
    lighter.positions[1] = { ...lighter.positions[1], symbol: 'LIGHTER_FUTURE_ETH_USDC' };
    lighter.exposure[0].legs[1] = { ...lighter.exposure[0].legs[1], symbol: 'LIGHTER_FUTURE_ETH_USDC', exchange: 'LIGHTER' };
    const assets = account().assets.map((a) => (a.exchangeType === 'HYPERLIQUID' ? { ...a, exchangeType: 'LIGHTER' } : a));
    const [line] = lines(account({ assets }), lighter);
    expect(line.venue).toBe('Lighter');
    expect(line.move).toBeCloseTo(45000 / 27500 - 1, 4);
    const [covered] = lines(account({ assets }), lighter, { 'USDC/LIGHTER': 20000, 'USDT/CROSSEX': -20000 });
    expect(covered.move).toBeCloseTo(47000 / 27500 - 1, 4);
  });

  it('a USDC-quoted Binance leg stays in the pooled USDT wallet', () => {
    const binance = box();
    binance.positions[1] = { ...binance.positions[1], symbol: 'BINANCE_FUTURE_ETH_USDC' };
    binance.exposure[0].legs[1] = { ...binance.exposure[0].legs[1], symbol: 'BINANCE_FUTURE_ETH_USDC', exchange: 'BINANCE', quote: 'USDC' };
    const usdt = box();
    usdt.positions[1] = { ...usdt.positions[1], symbol: 'BINANCE_FUTURE_ETH_USDT' };
    usdt.exposure[0].legs[1] = { ...usdt.exposure[0].legs[1], symbol: 'BINANCE_FUTURE_ETH_USDT', exchange: 'BINANCE', quote: 'USDT' };
    const shift = { 'USDC/HYPERLIQUID': 5000, 'USDT/CROSSEX': -5000 };
    expect(lines(account(), binance, shift)).toEqual(lines(account(), usdt, shift));
    expect(lines(account(), binance, shift)).not.toEqual(lines(account(), box(), shift));
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
    expect(line.venue).toBe('Hyperliquid');
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
    expect(line.venue).toBe('Binance');
    expect(line.move).toBeCloseTo(7, 4);
  });

  it('gives no line for a coin when one leg has a blank mark, rather than pricing the other leg unhedged', () => {
    const blanked = box();
    blanked.positions[0] = { ...blanked.positions[0], markPrice: '' };
    const view = liquidationLines(account(), blanked)!;
    expect(view).toEqual({ lines: [], far: [], unknown: [{ base: 'ETH', venue: 'Gate', sinceMs: null }] });
    expect(lineFor(view, 'ETH')).toBeNull();
    expect(liquidationSides(account(), blanked, 'ETH')).toEqual({ down: null, up: null });
  });

  it('prices the $6M whale ETH hedge at +466%, and gives no line when either leg has no usable mark or maintenance', () => {
    const whaleAccount = whaleBook.account as CrossexAccount;
    const whalePositions = whaleBook.positions as PositionsResponse;
    const full = liquidationLines(whaleAccount, whalePositions)!;
    const eth = lineFor(full, 'ETH') as LiquidationLine;
    expect(Math.round(eth.price)).toBe(14001);
    expect(fmtMove(eth.move)).toBe('+466%');
    for (const symbol of ['BINANCE_FUTURE_ETH_USDT', 'HYPERLIQUID_FUTURE_ETH_USDC']) {
      for (const over of [{ markPrice: '' }, { markPrice: '0' }, { markPrice: 'NaN' }, { maintenanceMargin: '' }]) {
        const blanked = {
          ...whalePositions,
          positions: whalePositions.positions.map((p) => (p.symbol === symbol ? { ...p, ...over } : p)),
        };
        const view = liquidationLines(whaleAccount, blanked)!;
        expect(lineFor(view, 'ETH')).toBeNull();
        expect(view).toEqual({
          lines: full.lines.filter((l) => l.base !== 'ETH'),
          far: full.far,
          unknown: [{ base: 'ETH', venue: symbol.startsWith('HYPERLIQUID') ? 'Hyperliquid' : 'Binance', sinceMs: null }],
        });
        expect(liquidationSides(whaleAccount, blanked, 'ETH')).toEqual({ down: null, up: null });
      }
    }
  });

  it('is unknown for the whole account when a wallet equity is blank', () => {
    const assets = account().assets.map((a) => (a.exchangeType === 'HYPERLIQUID' ? { ...a, equity: '' } : a));
    expect(liquidationLines(account({ assets }), box())).toBeNull();
  });

  it('prices a line past a 10x pump, lists a coin no price liquidates as far, prices nothing with no positions, and is unknown without margin figures', () => {
    const wide = box();
    wide.positions[1].symbol = 'BINANCE_FUTURE_ETH_USDT';
    wide.exposure[0].legs[1] = { ...wide.exposure[0].legs[1], symbol: 'BINANCE_FUTURE_ETH_USDT', exchange: 'BINANCE', quote: 'USDT' };
    const [pump] = lines(account({ marginBalance: '30000' }), wide);
    expect(pump.move).toBeCloseTo(30000 / 2500 - 1, 4);
    expect(pump.price).toBeCloseTo(2300 * 12, 0);
    const flat = { ...wide, positions: wide.positions.map((p) => ({ ...p, maintenanceMargin: '0' })) };
    const far = liquidationLines(account({ marginBalance: '30000' }), flat);
    expect(far).toEqual({ lines: [], far: ['ETH'], unknown: [] });
    expect(liquidationSides(account({ marginBalance: '30000' }), flat, 'ETH')).toEqual({ down: null, up: null });
    expect(lineFor(far!, 'eth')).toBe('far');
    expect(lineFor(far!, 'HYPE')).toBeNull();
    expect(liquidationLines(account(), { positions: [], exposure: [] })).toEqual({ lines: [], far: [], unknown: [] });
    expect(liquidationLines(account({ marginBalance: 'n/a' }), box())).toBeNull();
    expect(liquidationLines(account({ maintenanceMargin: undefined as unknown as string }), box())).toBeNull();
  });

  it('prices a hedged coin across every venue at once', () => {
    const view = liquidationLines(account(), box())!;
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].base).toBe('ETH');
    expect(view.lines[0].move).toBeCloseTo(45000 / 27500 - 1, 4);
    expect(view.lines[0].move).not.toBeCloseTo(17500 / 276250, 2);
  });

  it('names the venue of the losing leg', () => {
    const [pump] = lines(account(), box());
    expect(pump.move).toBeGreaterThan(0);
    expect(pump.venue).toBe('Hyperliquid');
    expect(pump.side).toBe('short');

    const flipped = box();
    flipped.exposure[0].legs[0].side = 'SHORT';
    flipped.exposure[0].legs[1].side = 'LONG';
    const [shortOnGate] = lines(account(), flipped);
    expect(shortOnGate.move).toBeGreaterThan(0);
    expect(shortOnGate.venue).toBe('Gate');
    expect(shortOnGate.side).toBe('short');

    const longOnly: PositionsResponse = {
      positions: [position('GATE_FUTURE_ETH_USDT', { positionValue: '250000', markPrice: '2300', maintenanceMargin: '1250' })],
      exposure: [
        group('ETH', [{ symbol: 'GATE_FUTURE_ETH_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: 108.7, value: 250000 }]),
      ],
    };
    const [dump] = lines(account({ maintenanceMargin: '1250' }), longOnly);
    expect(dump.move).toBeLessThan(0);
    expect(dump.venue).toBe('Gate');
    expect(dump.side).toBe('long');
  });

  it('names the venue of the losing leg in the sentence, not the wallet it margins in', () => {
    const [pump] = lines(account(), box());
    expect(describeLine(pump)).toContain('Losing leg: Hyperliquid short.');

    const flipped = box();
    flipped.exposure[0].legs[0].side = 'SHORT';
    flipped.exposure[0].legs[1].side = 'LONG';
    expect(describeLine(lines(account(), flipped)[0])).toContain('Losing leg: Gate short.');

    const binance = box();
    binance.positions[1].symbol = 'BINANCE_FUTURE_ETH_USDT';
    binance.exposure[0].legs[1] = {
      ...binance.exposure[0].legs[1],
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      exchange: 'BINANCE',
      quote: 'USDT',
    };
    expect(describeLine(lines(account(), binance)[0])).toContain('Losing leg: Binance short.');
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
    const eth = lineFor(view, 'ETH') as LiquidationLine;
    expect(eth.move).toBeCloseTo(4.13, 1);
    expect(eth.price).toBeCloseTo(2492.5 * 5.13, -1);
    expect(eth.venue).toBe('Hyperliquid');
    // HYPE: 926.55 eaten at 0.06 (net) + 13.26 (legs) + 19.94 (borrow) = 33.3 per 1x → +27.9.
    expect((lineFor(view, 'HYPE') as LiquidationLine).move).toBeCloseTo(926.55 / 33.26, 0);
    expect(view.far).toEqual([]);
    expect(view.lines[0].base).toBe('ETH');
  });
});

describe('liquidationSides', () => {
  it('gives both lines of a book that borrows either way, each with the losing leg and its exchange', () => {
    const flipped = box();
    flipped.exposure[0].legs[0].side = 'SHORT';
    flipped.exposure[0].legs[1].side = 'LONG';
    const sides = liquidationSides(account(), flipped, 'eth');
    expect(sides?.up?.move).toBeCloseTo(47000 / 27500 - 1, 4);
    expect(sides?.up).toMatchObject({ base: 'ETH', venue: 'Gate', exchange: 'GATE', side: 'short' });
    expect(sides?.down?.move).toBeCloseTo(5000 / 22500 - 1, 4);
    expect(sides?.down).toMatchObject({ base: 'ETH', venue: 'Hyperliquid', exchange: 'HYPERLIQUID', side: 'long' });
    expect(lines(account(), flipped)[0].price).toBe(sides?.up?.price);
  });

  it('puts both lines at the mark when the account is at liquidation now', () => {
    const sides = liquidationSides(account({ marginBalance: '2500' }), box(), 'ETH');
    expect(sides?.up).toMatchObject({ price: 2300, move: 0, exchange: 'HYPERLIQUID', side: 'short' });
    expect(sides?.down).toMatchObject({ price: 2300, move: 0, exchange: 'GATE', side: 'long' });
  });

  it('is null without margin figures, and empty for a coin not held', () => {
    expect(liquidationSides(account({ marginBalance: 'x' }), box(), 'ETH')).toBeNull();
    expect(liquidationSides(account(), box(), 'BTC')).toEqual({ down: null, up: null });
  });
});

describe('formatting', () => {
  it("writes moves as whole signed percents and prices to the coin's scale", () => {
    expect(fmtMove(0.3712)).toBe('+37%');
    expect(fmtMove(-0.2)).toBe('-20%');
    expect(fmtLinePrice(3150.4)).toBe('~$3,150');
    expect(fmtLinePrice(115.23)).toBe('~$115.23');
    expect(lineLabel({ base: 'ETH', venue: 'Hyperliquid', side: 'short', price: 3150, move: 0.37 })).toBe(
      'Liquidation ~$3,150 (+37%)',
    );
    expect(lineLabel({ base: 'ETH', venue: 'CrossEx', side: 'long', price: 1840, move: -0.2 })).toBe(
      'Liquidation ~$1,840 (-20%)',
    );
    expect(describeLine({ base: 'ETH', venue: 'Hyperliquid', side: 'short', price: 3150, move: 0.37 })).toBe(
      'ETH rises to $3,150 (+37%). Losing leg: Hyperliquid short. Estimate: other coins flat.',
    );
    expect(describeLine({ base: 'ETH', venue: 'Gate', side: 'long', price: 1840, move: -0.2 })).toBe(
      'ETH falls to $1,840 (-20%). Losing leg: Gate long. Estimate: other coins flat.',
    );
    expect(describeLine({ base: 'ETH', venue: 'Gate', side: null, price: 1840, move: -0.2 })).toBe(
      'ETH falls to $1,840 (-20%). Estimate: other coins flat.',
    );
  });
});

const HYPE_GATE_TIERS = [
  { from: 0, rate: 0.015, deduction: 0 },
  { from: 200_000, rate: 0.018, deduction: 600 },
  { from: 300_000, rate: 0.02, deduction: 1_200 },
  { from: 500_000, rate: 0.025, deduction: 3_700 },
  { from: 1_000_000, rate: 0.08, deduction: 58_700 },
  { from: 6_000_000, rate: 0.1, deduction: 178_700 },
];

const HYPE_TIERS: MarginTiers = {
  GATE_FUTURE_HYPE_USDT: HYPE_GATE_TIERS,
  HYPERLIQUID_FUTURE_HYPE_USDC: [{ from: 0, rate: 0.05, deduction: 0 }],
};

const hypeBox = (leg: number, gateMm: number): PositionsResponse => ({
  positions: [
    position('GATE_FUTURE_HYPE_USDT', { positionValue: String(leg), markPrice: '40', maintenanceMargin: String(gateMm) }),
    position('HYPERLIQUID_FUTURE_HYPE_USDC', { positionValue: String(leg), markPrice: '40', maintenanceMargin: String(leg * 0.05) }),
  ],
  exposure: [
    group('HYPE', [
      { symbol: 'GATE_FUTURE_HYPE_USDT', exchange: 'GATE', quote: 'USDT', side: 'LONG', qty: leg / 40, value: leg },
      { symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', exchange: 'HYPERLIQUID', quote: 'USDC', side: 'SHORT', qty: leg / 40, value: leg },
    ]),
  ],
});

const hypeAccount = (capital: number, maintenance: number): CrossexAccount =>
  account({
    marginBalance: String(capital),
    maintenanceMargin: String(maintenance),
    assets: [
      { coin: 'USDT', exchangeType: 'CROSSEX', balance: String(capital), equity: String(capital), availableBalance: String(capital), upnl: '0', liability: '0' },
      { coin: 'USDC', exchangeType: 'HYPERLIQUID', balance: '0', equity: '0', availableBalance: '0', upnl: '0', liability: '0' },
    ],
  });

describe("Gate's maintenance margin tiers", () => {
  it('charges the same at the tier edge from either side: Gate HYPE steps to 8% at $1,000,000', () => {
    expect(maintenanceAt(HYPE_GATE_TIERS, 1_000_000)).toBeCloseTo(21_300, 6);
    expect(maintenanceAt(HYPE_GATE_TIERS, 999_999)).toBeCloseTo(21_299.975, 3);
    expect(maintenanceAt(HYPE_GATE_TIERS, 1_000_001)).toBeCloseTo(21_300.08, 2);
    expect(maintenanceAt(HYPE_GATE_TIERS, 6_000_000)).toBeCloseTo(421_300, 6);
    expect(maintenanceAt([], 1_000_000)).toBe(0);
  });

  it('pulls the line in on a $400,000 account whose Gate HYPE leg crosses the $1,000,000 tier', () => {
    const acc = hypeAccount(400_000, 52_550);
    const box = hypeBox(750_000, 15_050);
    expect(lines(acc, box)[0].price).toBeCloseTo(148.96, 1);
    expect(lines(acc, box, {}, HYPE_TIERS)[0].price).toBeCloseTo(123.76, 1);
  });

  it('pulls the line in on a $6,000,000 account, where every dollar of the move is charged at 10%', () => {
    const acc = hypeAccount(6_000_000, 721_300);
    const box = hypeBox(6_000_000, 421_300);
    expect(lines(acc, box)[0].price).toBeCloseTo(199.8, 1);
    expect(lines(acc, box, {}, HYPE_TIERS)[0].price).toBeCloseTo(180.77, 1);
  });

  it('keeps the flat line when the table has no row for the coin', () => {
    const acc = hypeAccount(400_000, 52_550);
    const box = hypeBox(750_000, 15_050);
    expect(lines(acc, box, {}, {})[0].price).toBeCloseTo(lines(acc, box)[0].price, 6);
    expect(lines(acc, box, {}, { GATE_FUTURE_ETH_USDT: HYPE_GATE_TIERS })[0].price).toBeCloseTo(
      lines(acc, box)[0].price,
      6,
    );
  });

  it('takes the nearer of the two lines when the table disagrees with what Gate charges the leg', () => {
    const tableLow = { acc: hypeAccount(400_000, 53_302.5), box: hypeBox(750_000, 15_802.5) };
    const tableHigh = { acc: hypeAccount(400_000, 51_797.5), box: hypeBox(750_000, 14_297.5) };
    for (const { acc, box } of [tableLow, tableHigh]) {
      const flat = lines(acc, box)[0].price;
      const shown = lines(acc, box, {}, HYPE_TIERS)[0].price;
      expect(shown).toBeLessThanOrEqual(flat);
      expect(flat - shown).toBeGreaterThan(10);
    }
  });

  it('keeps the tiered line when the table is within 1% of what Gate charges', () => {
    const gateMm = 15_050 * 1.005;
    const acc = hypeAccount(400_000, 37_500 + gateMm);
    const box = hypeBox(750_000, gateMm);
    expect(lines(acc, box, {}, HYPE_TIERS)[0].price).toBeLessThan(lines(acc, box)[0].price - 20);
  });

  it('keeps the table on a leg Gate prices at zero maintenance, without a NaN', () => {
    const acc = hypeAccount(400_000, 37_500);
    const box = hypeBox(750_000, 0);
    const tiered = lines(acc, box, {}, HYPE_TIERS)[0].price;
    expect(Number.isFinite(tiered)).toBe(true);
    expect(tiered).toBeLessThan(lines(acc, box)[0].price - 10);
  });

  it('gives the Telegram side the same tiered line as the card', () => {
    const acc = hypeAccount(400_000, 52_550);
    const box = hypeBox(750_000, 15_050);
    expect(liquidationSides(acc, box, 'HYPE', HYPE_TIERS)!.up!.price).toBeCloseTo(
      lines(acc, box, {}, HYPE_TIERS)[0].price,
      6,
    );
  });
});

describe('a coin with no usable mark', () => {
  const blind = (): PositionsResponse => {
    const b = box();
    b.positions[1] = position('HYPERLIQUID_FUTURE_ETH_USDC', {
      positionValue: '250000',
      markPrice: '',
      maintenanceMargin: '1250',
    });
    return b;
  };

  it('names the coin, the venue of the leg and the time, instead of dropping it', () => {
    const view = liquidationLines(account(), blind())!;
    expect(view.lines).toEqual([]);
    expect(view.unknown).toEqual([{ base: 'ETH', venue: 'Hyperliquid', sinceMs: null }]);
  });

  it('carries the time the server last had a price for that leg', () => {
    const positions = blind();
    const since = new Date(2026, 8, 21, 14, 32).getTime();
    (positions.positions[1] as unknown as { markStaleSinceMs: number }).markStaleSinceMs = since;
    const view = liquidationLines(account(), positions)!;
    expect(view.unknown[0].sinceMs).toBe(since);
    expect(unknownLabel({ venue: view.unknown[0].venue, sinceMs: since }, since + 4 * 3_600_000 + 12 * 60_000)).toBe(
      'No Hyperliquid price from Gate for 4h 12m.',
    );
  });

  it('leaves a priced coin out of the unknown list', () => {
    expect(liquidationLines(account(), box())!.unknown).toEqual([]);
  });

  it('names the venue of the blind leg, not the wallet it margins in', () => {
    const gate = box();
    gate.positions[0] = { ...gate.positions[0], markPrice: '' };
    expect(liquidationLines(account(), gate)!.unknown[0].venue).toBe('Gate');

    const hyperliquid = box();
    hyperliquid.positions[1] = { ...hyperliquid.positions[1], markPrice: '' };
    expect(liquidationLines(account(), hyperliquid)!.unknown[0].venue).toBe('Hyperliquid');

    const binance = box();
    binance.positions[0] = { ...binance.positions[0], symbol: 'BINANCE_FUTURE_ETH_USDT', markPrice: '' };
    binance.exposure[0].legs[0] = {
      ...binance.exposure[0].legs[0],
      symbol: 'BINANCE_FUTURE_ETH_USDT',
      exchange: 'BINANCE',
    };
    expect(liquidationLines(account(), binance)!.unknown[0].venue).toBe('Binance');
  });

  it('still draws the line from a mark the server remembered', () => {
    const held = box();
    held.positions[0] = { ...held.positions[0], markHeldSinceMs: Date.parse('2026-09-21T14:32:00Z') };
    const view = liquidationLines(account(), held)!;
    expect(view.unknown).toEqual([]);
    expect(view.lines[0].price).toBeCloseTo(lines(account(), box())[0].price, 6);
  });
});
