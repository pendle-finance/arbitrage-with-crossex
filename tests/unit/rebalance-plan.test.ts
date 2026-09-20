import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { roundToStep } from '../../src/core/numbers';
import {
  bookLevels,
  bucketsFrom,
  buyableUsdc,
  buyCostUsdt,
  CONVERT_RATE,
  fit,
  floorCents,
  HYPERLIQUID_DEPOSIT_FEE_USD,
  HYPERLIQUID_WITHDRAW_FEE_USD,
  nearestCents,
  notionalByWallet,
  planFor,
  roundSeconds,
  sellProceedsUsdt,
  SPOT_ORDER_MAX_USDC,
  spotOrderMax,
  USDC_WALLET,
  USDT_WALLET,
  type AccountLike,
  type AssetLike,
  type BookLevel,
  type CoinRuleLike,
  EVEN_GOAL,
  type EvenPlan,
  type Goal,
  type PlannedStep,
  type PlanInputs,
  type Pool,
  REPAY_GOAL,
  type RateLike,
  type RoutePlan,
  type WalletAfter,
} from '../../src/core/rebalance/plan';

type Figures = Partial<
  Record<
    | 'balance'
    | 'availableBalance'
    | 'upnl'
    | 'equity'
    | 'liability'
    | 'borrowingInitialMargin'
    | 'borrowingMaintenanceMargin',
    number
  >
>;

function asset(coin: string, exchangeType: string, f: Figures = {}): AssetLike {
  return {
    coin,
    exchangeType,
    balance: String(f.balance ?? 0),
    availableBalance: String(f.availableBalance ?? f.balance ?? 0),
    upnl: String(f.upnl ?? 0),
    equity: String(f.equity ?? 0),
    liability: String(f.liability ?? 0),
    borrowingInitialMargin: String(f.borrowingInitialMargin ?? 0),
    borrowingMaintenanceMargin: String(f.borrowingMaintenanceMargin ?? 0),
  };
}

const USDC_RATE: RateLike[] = [{ coin: USDC_WALLET.coin, exchangeType: USDC_WALLET.venue, hourInterestRate: '0.00001' }];
const BOTH_RATES: RateLike[] = [
  ...USDC_RATE,
  { coin: USDT_WALLET.coin, exchangeType: USDT_WALLET.venue, hourInterestRate: '0.00002' },
];

const LIVE_RATES: RateLike[] = [
  { coin: USDC_WALLET.coin, exchangeType: USDC_WALLET.venue, hourInterestRate: '0.0000057077626' },
  { coin: USDT_WALLET.coin, exchangeType: USDT_WALLET.venue, hourInterestRate: '0.000006436251' },
];

const cents = (value: number): string => roundToStep(value, '0.01', 'nearest');
const DUST = 1;

function accountOf(assets: AssetLike[]): AccountLike {
  return { availableMargin: '0', marginBalance: '0', initialMargin: '0', assets };
}

describe('bucketsFrom interest', () => {
  it('maps one row per asset: cash from balance, borrow from liability', () => {
    const account = accountOf([
      asset('USDC', 'HYPERLIQUID', { balance: -50, upnl: 10, equity: -40, liability: 50 }),
      asset('USDT', 'CROSSEX', { balance: 200, upnl: 0, equity: 200 }),
    ]);
    const buckets = bucketsFrom(account, USDC_RATE, {});
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ coin: 'USDC', venue: 'HYPERLIQUID', cash: -50, upnl: 10, equity: -40, borrow: 50 });
    expect(buckets[1]).toMatchObject({ coin: 'USDT', venue: 'CROSSEX', cash: 200, upnl: 0, equity: 200, borrow: 0 });
  });

  it('charges a USDC Hyperliquid borrow only on the part over 10000', () => {
    const account = accountOf([asset('USDC', 'HYPERLIQUID', { equity: -12000, liability: 12000 })]);
    const [usdc] = bucketsFrom(account, LIVE_RATES, {});
    expect(usdc.interestPerDayUsd).toBeCloseTo(2000 * 0.0000057077626 * 24, 9);
    expect(cents(usdc.interestPerDayUsd)).toBe('0.27');
    expect(usdc.ratePerYear).toBeCloseTo(0.0000057077626 * 24 * 365, 12);
  });

  it('gives the yearly rate on a USDC Hyperliquid borrow still inside the free 10000', () => {
    const account = accountOf([asset('USDC', 'HYPERLIQUID', { equity: -5000, liability: 5000 })]);
    const [usdc] = bucketsFrom(account, LIVE_RATES, {});
    expect(usdc.interestPerDayUsd).toBe(0);
    expect(cents((usdc.ratePerYear ?? 0) * 100)).toBe('5.00');
  });

  it('charges no interest on a USDC Hyperliquid borrow of 10000 or less', () => {
    const account = accountOf([
      asset('USDC', 'HYPERLIQUID', { equity: -5000, liability: 5000 }),
      asset('USDC', 'HYPERLIQUID', { equity: -10000, liability: 10000 }),
    ]);
    expect(bucketsFrom(account, LIVE_RATES, {}).map((b) => b.interestPerDayUsd)).toEqual([0, 0]);
  });

  it('uses rate 0 when no rate row matches the coin and venue', () => {
    const account = accountOf([asset('USDC', 'HYPERLIQUID', { equity: -20000, liability: 20000 })]);
    const other: RateLike[] = [{ coin: 'USDC', exchangeType: 'GATE', hourInterestRate: '0.5' }];
    const [usdc] = bucketsFrom(account, other, {});
    expect(usdc.interestPerDayUsd).toBe(0);
    expect(usdc.ratePerYear).toBeNull();
  });

  it('reads the all-time interest paid by wallet key', () => {
    const account = accountOf([asset('USDC', 'HYPERLIQUID', { equity: -500 }), asset('USDT', 'CROSSEX')]);
    const paid = { 'USDC/HYPERLIQUID': 3.75, 'USDC/GATE': 9, 'USDT/CROSSEX': 4 };
    const [usdc, usdt] = bucketsFrom(account, USDC_RATE, paid);
    expect(usdc.interestPaidUsd).toBe(3.75);
    expect(usdt.interestPaidUsd).toBe(4);
  });

  it('reads interest paid as 0 with no entry for the wallet', () => {
    const account = accountOf([asset('USDC', 'HYPERLIQUID', { equity: -500 }), asset('USDT', 'CROSSEX')]);
    const [usdc, usdt] = bucketsFrom(account, USDC_RATE, { 'USDC/GATE': 9 });
    expect(usdc.interestPaidUsd).toBe(0);
    expect(usdt.interestPaidUsd).toBe(0);
  });

  it('charges a USDC Lighter borrow from the first dollar at the Lighter rate', () => {
    const rates: RateLike[] = [...LIVE_RATES, { coin: 'USDC', exchangeType: 'LIGHTER', hourInterestRate: '0.0000125' }];
    const account = accountOf([asset('USDC', 'LIGHTER', { equity: -500, liability: 500 })]);
    const [lighter] = bucketsFrom(account, rates, {});
    expect(lighter.interestPerDayUsd).toBeCloseTo(500 * 0.0000125 * 24, 9);
    expect(cents(lighter.interestPerDayUsd)).toBe('0.15');
    expect(cents((lighter.ratePerYear ?? 0) * 100)).toBe('10.95');
  });

  it('charges a USDT borrow from the first dollar at the USDT rate', () => {
    const account = accountOf([asset('USDC', 'HYPERLIQUID'), asset('USDT', 'CROSSEX', { equity: -2000, liability: 2000 })]);
    const [usdc, usdt] = bucketsFrom(account, LIVE_RATES, {});
    expect(usdt).toMatchObject({ borrow: 2000 });
    expect(usdt.interestPerDayUsd).toBeCloseTo(2000 * 0.000006436251 * 24, 9);
    expect(cents(usdt.interestPerDayUsd)).toBe('0.31');
    expect(usdc.interestPerDayUsd).toBe(0);
  });
});

describe('bucketsFrom held margin', () => {
  it('reads imHeldUsd and mmHeldUsd from the asset borrowing margins', () => {
    const account = accountOf([
      asset('USDC', 'HYPERLIQUID', {
        equity: -300,
        liability: 300,
        borrowingInitialMargin: 60,
        borrowingMaintenanceMargin: 30,
      }),
      asset('USDT', 'CROSSEX', { balance: 1200, equity: 1200 }),
    ]);
    const [usdc, usdt] = bucketsFrom(account, USDC_RATE, {});
    expect(usdc).toMatchObject({ borrow: 300, imHeldUsd: 60, mmHeldUsd: 30 });
    expect(usdt).toMatchObject({ imHeldUsd: 0, mmHeldUsd: 0 });
  });

  it('reads held margin as 0 when the asset margin is not a number', () => {
    const account = accountOf([
      { ...asset('USDC', 'HYPERLIQUID'), borrowingInitialMargin: '', borrowingMaintenanceMargin: 'n/a' },
    ]);
    const [usdc] = bucketsFrom(account, USDC_RATE, {});
    expect(usdc).toMatchObject({ imHeldUsd: 0, mmHeldUsd: 0 });
  });
});

describe('fit', () => {
  it('moves margin balance less 112 percent of initial margin, floored to cents', () => {
    expect(fit({ marginBalance: 57.45, initialMargin: 29.41 }, 1000)).toBe(24.51);
  });

  it('never moves more than the sending cash', () => {
    expect(fit({ marginBalance: 988.23, initialMargin: 156.28 }, 11.92)).toBe(11.92);
  });

  it('is 0 when margin balance is under the 112 percent floor', () => {
    expect(fit({ marginBalance: 100, initialMargin: 95 }, 50)).toBe(0);
  });

  it('is 0 when the sending cash is negative', () => {
    expect(fit({ marginBalance: 1000, initialMargin: 0 }, -5)).toBe(0);
  });

  it('counts the initial margin of a borrow the move creates', () => {
    const moved = fit({ marginBalance: 1000, initialMargin: 100 }, 888, 0);
    expect(moved).toBe(725.49);
    expect(1000 - moved).toBeGreaterThanOrEqual(1.12 * (100 + moved / 5));
  });

  it('counts only the part of the move past the wallet equity as borrow', () => {
    const moved = fit({ marginBalance: 1000, initialMargin: 100 }, 888, 500);
    expect(moved).toBe(816.99);
    expect(1000 - moved).toBeGreaterThanOrEqual(1.12 * (100 + (moved - 500) / 5));
  });

  it('counts no borrow when the wallet equity covers the move', () => {
    expect(fit({ marginBalance: 1000, initialMargin: 100 }, 888, 900)).toBe(888);
  });

  it('counts the whole move as borrow when the wallet equity is below 0', () => {
    expect(fit({ marginBalance: 1000, initialMargin: 100 }, 888, -50)).toBe(725.49);
  });
});

interface Fixture {
  usdt: number;
  gate: number;
  usdc: number;
  usdcUpnl?: number;
  positionIm: number;
}

const ACCOUNT_A: Fixture = { usdt: 92.54, gate: 111.96, usdc: -147.05, positionIm: 0 };
const ACCOUNT_A_ROUND_3: Fixture = { usdt: 92.54, gate: 20.94, usdc: -92.71, positionIm: 0 };
const ACCOUNT_B: Fixture = { usdt: 971.22, gate: 0.29, usdc: 16.91, positionIm: 153.85 };
const EXAMPLE_C: Fixture = { usdt: 165.45, gate: 0, usdc: 22.18, usdcUpnl: 203.64, positionIm: 96.4 };
const EXAMPLE_D: Fixture = { usdt: 12081.77, gate: 0, usdc: -9612.4, positionIm: 0 };
const EXAMPLE_E: Fixture = { usdt: -612.35, gate: 0, usdc: 1842.16, positionIm: 310 };
const THIN_MARGIN: Fixture = { usdt: 1000, gate: 0, usdc: 948, positionIm: 1728.57 };

const USDC_RULE: CoinRuleLike = { coin: 'USDC', minTransAmount: 11, estFee: 1, isDisabled: 0 };

const OPEN: PlanInputs = {
  coins: [USDC_RULE],
  spotRule: { state: 'live' },
  spotTakerRate: 0,
  ask: 1.0001,
  bid: 0.9999,
  notional: { 'USDT/CROSSEX': 1000, 'USDC/HYPERLIQUID': 1000 },
};

const TO_USDC_WAIT_SECONDS = roundSeconds('CROSSEX', 'HYPERLIQUID');

function wallet(coin: string, venue: string, cash: number, upnl = 0): AssetLike {
  const borrow = Math.max(0, -cash);
  return asset(coin, venue, {
    balance: cash,
    upnl,
    equity: Number(cents(cash + upnl)),
    liability: borrow,
    borrowingInitialMargin: Number(cents(borrow / 5)),
    borrowingMaintenanceMargin: Number(cents(borrow / 10)),
  });
}

function accountFor(f: Fixture): AccountLike {
  const marginBalance = f.usdt + f.gate + f.usdc + (f.usdcUpnl ?? 0);
  const initialMargin = f.positionIm + Math.max(0, -f.usdt) / 5 + Math.max(0, -f.usdc) / 5;
  return {
    availableMargin: cents(marginBalance - initialMargin),
    marginBalance: cents(marginBalance),
    initialMargin: cents(initialMargin),
    assets: [
      wallet(USDT_WALLET.coin, USDT_WALLET.venue, f.usdt),
      wallet(USDC_WALLET.coin, USDC_WALLET.venue, f.usdc, f.usdcUpnl ?? 0),
      wallet('USDC', 'GATE', f.gate),
    ],
  };
}

function planOf(f: Fixture, inputs: PlanInputs = OPEN) {
  const account = accountFor(f);
  return planFor(bucketsFrom(account, BOTH_RATES, {}), account, inputs);
}

const walletIn = (after: WalletAfter[], coin: string, venue: string): WalletAfter => {
  const found = after.find((w) => w.coin === coin && w.venue === venue);
  if (!found) throw new Error(`no ${coin}/${venue} in after`);
  return found;
};

describe('planFor Account A', () => {
  const plan = planOf(ACCOUNT_A);

  it('A after is even', () => {
    for (const route of [plan.routes.loop!, plan.routes.convert]) {
      const usdt = walletIn(route.after, 'USDT', 'CROSSEX').equity;
      const usdc = walletIn(route.after, 'USDC', 'HYPERLIQUID').equity;
      expect(Math.abs(usdt - usdc)).toBeLessThanOrEqual(0.05);
    }
  });

  it('A Gate bucket ends empty', () => {
    expect(walletIn(plan.routes.loop!.after, 'USDC', 'GATE').cash).toBe(0);
    expect(walletIn(plan.routes.convert.after, 'USDC', 'GATE').cash).toBe(0);
  });

  it('A round 1 buys nothing', () => {
    expect(plan.routes.loop!.steps[0].buy).toBe(0);
  });

  it('A round 1 is sized at 112 percent', () => {
    expect(plan.routes.loop!.steps[0].move).toBe(24.51);
  });

  it('A mix is null', () => {
    expect(plan.routes.mix).toBeNull();
  });

  it('A recommends loop', () => {
    expect(plan.recommended).toBe('loop');
  });

  it('A loop frees 29.41', () => {
    expect(plan.routes.loop!.marginFreedUsd).toBeCloseTo(29.41, 2);
  });

  it('A loop takes 650 s', () => {
    expect(plan.routes.loop!.seconds).toBe(650);
  });

  it('A loop runs five rounds whose sizes grow as the borrow is repaid', () => {
    const moves = plan.routes.loop!.steps.map((step) => step.move);
    expect(moves.slice(0, 4)).toEqual([24.51, 29.93, 36.58, 44.71]);
    expect(plan.routes.loop!.rounds).toBe(5);
    expect(plan.routes.loop!.costUsd).toBeCloseTo(0.26, 2);
    expect(plan.routes.loop!.steps.every((step) => step.seconds === TO_USDC_WAIT_SECONDS)).toBe(true);
  });

  it('A round 4 buys what the Gate bucket no longer covers', () => {
    const round4 = plan.routes.loop!.steps[3];
    expect(round4).toMatchObject({ round: 4, kind: 'round', buy: 23.77, move: 44.71, arrives: 44.66 });
  });

  it('A convert sends one step and prices the Gate bucket sale in its cost', () => {
    expect(plan.routes.convert.steps).toHaveLength(1);
    expect(plan.routes.convert.steps[0]).toMatchObject({ round: null, kind: 'convert', buy: 0, move: 175.94, seconds: 0 });
    expect(plan.routes.convert.costUsd).toBeCloseTo(0.38, 2);
  });
});

describe('planFor Account A, round 3 in Gate spot', () => {
  const plan = planOf(ACCOUNT_A_ROUND_3);

  it('no free margin leaves a loop with no round, closed with its reason, and no mix', () => {
    expect(plan.routes.loop).toMatchObject({ available: false });
    expect(plan.routes.loop!.reason).not.toBeNull();
    expect(plan.routes.mix).toBeNull();
  });

  it('convert stays open when no round fits', () => {
    expect(plan.routes.convert).toMatchObject({ available: true, reason: null });
    expect(plan.recommended).toBe('convert');
  });
});

describe('planFor Account B', () => {
  const plan = planOf(ACCOUNT_B);

  it('B moves to even with no borrow', () => {
    expect(Math.abs(plan.moves - 477.29)).toBeLessThanOrEqual(0.05);
  });

  it('B Gate dust stays', () => {
    expect(walletIn(plan.routes.loop!.after, 'USDC', 'GATE').cash).toBe(0.29);
  });

  it('B is not short of even when cash covers the move', () => {
    expect(plan.shortOfEven).toBe(0);
  });

  it('B frees nothing without a borrow', () => {
    expect(plan.routes.loop).toMatchObject({ marginFreedUsd: 0, savesPerDayUsd: 0 });
  });
});

describe('planFor Example C', () => {
  const plan = planOf(EXAMPLE_C);

  it('C recommends convert', () => {
    expect(plan.recommended).toBe('convert');
  });

  it('C moves only cash', () => {
    expect(plan.moves).toBe(22.18);
  });

  it('C short of even', () => {
    expect(plan.shortOfEven).toBe(8);
  });

  it('C lists the 1.00 round Spot loop beside Convert, dearer and not recommended', () => {
    expect(plan.routes.convert.steps[0]).toMatchObject({ from: 'HYPERLIQUID', to: 'CROSSEX' });
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.loop!.costUsd).toBeGreaterThan(plan.routes.convert.costUsd);
    expect(plan.recommended).toBe('convert');
    expect(plan.routes.convert.costUsd).toBeCloseTo(0.05, 2);
  });
});

describe('planFor Example D', () => {
  const plan = planOf(EXAMPLE_D);

  it('D lists the 11 round Spot loop, over 15 min and so not recommended', () => {
    expect(plan.routes.loop).toMatchObject({ available: true, rounds: 11 });
    expect(plan.routes.loop!.seconds).toBeGreaterThan(900);
    expect(plan.recommended).not.toBe('loop');
  });

  it('D recommends mix', () => {
    expect(plan.recommended).toBe('mix');
  });

  it('D mix is 6 rounds then Convert', () => {
    const steps = plan.routes.mix!.steps;
    expect(steps.filter((step) => step.kind === 'round').map((step) => step.move)).toEqual([
      316.19, 386.92, 473.49, 579.44, 709.12, 867.83,
    ]);
    expect(steps).toHaveLength(7);
    expect(steps[6]).toMatchObject({ kind: 'convert', round: null });
    expect(steps[6].move).toBeCloseTo(7521.97, 2);
  });

  it('D saves nothing under the interest line', () => {
    expect(plan.routes.mix!.savesPerDayUsd).toBe(0);
  });

  it('D mix takes 780 s', () => {
    expect(plan.routes.mix!.seconds).toBe(780);
  });

  it('D mix at the round cap has no one more round cost', () => {
    expect(plan.roundCap).toBe(6);
    expect(plan.routes.mix!.oneMoreRoundCostUsd).toBeNull();
    expect(plan.routes.mix!.costUsd).toBeCloseTo(16.43, 2);
    expect(plan.routes.mix!.marginFreedUsd).toBeCloseTo(1922.48, 2);
  });
});

describe('planFor Example E', () => {
  const plan = planOf(EXAMPLE_E);

  it('E mix stops at 1 round', () => {
    expect(plan.routes.mix!.rounds).toBe(1);
  });

  it('E one more round cost', () => {
    expect(plan.routes.mix!.oneMoreRoundCostUsd).toBeCloseTo(2.12, 2);
  });

  it('E lists the 2 round loop beside the mix, and the cheaper mix is the pick', () => {
    expect(plan.routes.loop).toMatchObject({ available: true, rounds: 2 });
    expect(plan.routes.mix!.costUsd).toBeLessThan(plan.routes.loop!.costUsd);
    expect(plan.routes.mix!.costUsd).toBeLessThan(plan.routes.convert.costUsd);
  });

  it('E rounds move out of the Hyperliquid wallet less the 1.00 fee', () => {
    expect(plan.routes.mix!.steps[0]).toMatchObject({ from: 'HYPERLIQUID', to: 'CROSSEX' });
    expect(plan.routes.mix!.steps[0]).toMatchObject({ kind: 'round', buy: 0, move: 745.44, arrives: 744.44, seconds: 400 });
    expect(plan.routes.mix!.costUsd).toBeCloseTo(2.09, 2);
    expect(plan.routes.mix!.marginFreedUsd).toBeCloseTo(122.47, 2);
    expect(plan.recommended).toBe('mix');
  });
});

describe('planFor Spot loop row', () => {
  it('toward USDT with rounds of 122, the 116 round loop is past the round cap and closes with that reason', () => {
    const plan = planOf({ usdt: 10038.19, gate: 0, usdc: 29676.27, positionIm: 35350 });
    expect(plan.routes.loop).toMatchObject({ available: false, reason: 'Spot loop would take more than 100 rounds.' });
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.convert).toMatchObject({ available: true, costUsd: 20.64 });
    expect(plan.recommended).toBe('convert');
  });

  it('toward USDC with rounds of 122, the mix stops at 6 rounds in 15 min and Converts the rest for less', () => {
    const plan = planOf({ usdt: 29676.27, gate: 0, usdc: 10038.19, positionIm: 35350 });
    expect(plan.routes.loop).not.toBeNull();
    expect(plan.routes.loop!.seconds).toBeGreaterThan(900);
    expect(plan.routes.mix).toMatchObject({ available: true, rounds: 6, seconds: 780, costUsd: 19.47 });
    expect(plan.routes.mix!.steps.at(-1)).toMatchObject({ kind: 'convert' });
    expect(plan.routes.convert.costUsd).toBe(20.64);
    expect(plan.recommended).toBe('mix');
  });

  it.each([
    { name: 'toward USDT closes the dearer mix row too', usdt: 10038.19, usdc: 29676.27, mix: null },
    { name: 'toward USDC shows the closed 19.47 row with its reason', usdt: 29676.27, usdc: 10038.19, mix: 19.47 },
  ])('with Gate spot closed, $name', (row) => {
    const plan = planOf({ usdt: row.usdt, gate: 0, usdc: row.usdc, positionIm: 35350 }, { ...OPEN, spotRule: { state: 'halted' } });
    expect(plan.routes.loop).toMatchObject({ available: false, reason: 'The spot market for USDC is closed.' });
    if (row.mix === null) expect(plan.routes.mix).toMatchObject({ available: false, reason: 'The spot market for USDC is closed.' });
    else expect(plan.routes.mix).toMatchObject({ available: false, reason: 'The spot market for USDC is closed.', costUsd: row.mix });
    expect(plan.routes.convert).toMatchObject({ available: true, costUsd: 20.64 });
    expect(plan.recommended).toBe('convert');
  });

  it.each([
    ['Account A', ACCOUNT_A],
    ['Account B', ACCOUNT_B],
    ['Example C', EXAMPLE_C],
    ['Example D', EXAMPLE_D],
    ['Example E', EXAMPLE_E],
    ['Thin margin', THIN_MARGIN],
  ])('%s never recommends a route over 15 min, however many it lists', (_name, fixture) => {
    const plan = planOf(fixture);
    expect(plan.routes.loop).not.toBeNull();
    const picked = plan.recommended;
    if (picked !== null) expect(plan.routes[picked]!.seconds).toBeLessThanOrEqual(900);
  });
});

describe('planFor toward USDT with USDC in the Gate bucket', () => {
  const plan = planOf({ usdt: 100, gate: 50, usdc: 250, positionIm: 0 });

  const large = planOf({ usdt: 5000, gate: 2500, usdc: 12500, positionIm: 0 });

  it('toward USDT sells the Gate bucket and ends even', () => {
    for (const [route, even] of [
      [plan.routes.convert, 200],
      [large.routes.loop!, 10000],
      [large.routes.convert, 10000],
    ] as const) {
      const usdt = walletIn(route.after, 'USDT', 'CROSSEX').equity;
      const usdc = walletIn(route.after, 'USDC', 'HYPERLIQUID').equity;
      expect(walletIn(route.after, 'USDC', 'GATE').cash).toBe(0);
      expect(Math.abs(usdt - even)).toBeLessThanOrEqual(3);
      expect(Math.abs(usdt - usdc)).toBeLessThanOrEqual(0.05);
    }
  });

  it('toward USDT prices the Gate bucket sale in the cost', () => {
    expect(plan.routes.convert.steps).toEqual([expect.objectContaining({ kind: 'convert', move: 50.05 })]);
    expect(plan.routes.convert.costUsd).toBeCloseTo(0.11, 2);
    expect(walletIn(plan.routes.convert.after, 'USDT', 'CROSSEX').equity).toBe(199.93);
    expect(large.routes.loop!.steps).toEqual([expect.objectContaining({ kind: 'round', move: 2500.74, arrives: 2499.74 })]);
    expect(large.routes.loop!.costUsd).toBe(1.5);
    expect(walletIn(large.routes.loop!.after, 'USDT', 'CROSSEX').equity).toBe(9999.24);
  });

  it('toward USDT keeps Gate bucket dust under 1', () => {
    const dust = planOf({ usdt: 5000, gate: 0.5, usdc: 12500, positionIm: 0 });
    expect(walletIn(dust.routes.loop!.after, 'USDC', 'GATE').cash).toBe(0.5);
    expect(walletIn(dust.routes.convert.after, 'USDC', 'GATE').cash).toBe(0.5);
  });
});

describe('planFor sending wallet with no cash', () => {
  const plan = planOf({ usdt: 100, gate: 0, usdc: -5, usdcUpnl: 500, positionIm: 0 });

  it('no cash to send is balanced and keeps short of even', () => {
    expect(plan).toMatchObject({ balanced: true, noLegs: false, moves: 0, shortOfEven: 197.5, recommended: null });
  });

  it('no cash to send leaves no route to start', () => {
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.loop).toMatchObject({ available: false, steps: [] });
    expect(plan.routes.convert).toMatchObject({ available: false, steps: [] });
  });
});

describe('planFor interest saved', () => {
  it('a repaid USDT borrow saves interest from the first dollar', () => {
    const plan = planOf(EXAMPLE_E);
    expect(plan.routes.mix!.savesPerDayUsd).toBe(Number(cents(612.35 * 0.00002 * 24)));
    expect(plan.routes.mix!.savesPerDayUsd).toBe(0.29);
  });

  it('a repaid USDC Hyperliquid borrow saves only the interest on the part over 10000', () => {
    const plan = planOf({ usdt: 5000, gate: 0, usdc: -12000, positionIm: 0 });
    expect(plan.recommended).toBe('convert');
    expect(walletIn(plan.routes.convert.after, 'USDC', 'HYPERLIQUID').equity).toBeGreaterThan(-10000);
    expect(plan.routes.convert.savesPerDayUsd).toBe(Number(cents(2000 * 0.00001 * 24)));
    const partial = planOf({ usdt: 1000, gate: 0, usdc: -13000, positionIm: 0 }).routes.convert;
    expect(partial.steps).toEqual([expect.objectContaining({ move: 1000, arrives: 997.9 })]);
    expect(partial.savesPerDayUsd).toBe(Number(cents((3000 - 2002.1) * 0.00001 * 24)));
  });
});

describe('planFor Thin margin', () => {
  const plan = planOf(THIN_MARGIN);

  it('thin margin recommends Convert, with the loop of 11 and 12 rounds listed at its higher cost', () => {
    expect(plan.routes.loop!.costUsd).toBeGreaterThanOrEqual(plan.routes.convert.costUsd);
    expect(plan.routes.mix).toBeNull();
    expect(plan.recommended).toBe('convert');
  });
});

describe('planFor loop sizing', () => {
  it('the last 11 goes by Convert, because a Convert of 11 costs less than a round', () => {
    const plan = planOf({ usdt: 1200, gate: 0, usdc: 1000, positionIm: 1884.8 });
    expect(plan.routes.mix!.steps.map((step) => [step.kind, step.move])).toEqual([
      ['round', 89.02],
      ['convert', 11.01],
    ]);
    expect(plan.recommended).toBe('mix');
  });

  it('11 USDC out of Hyperliquid recommends Convert, because the 1.00 round fee costs more', () => {
    const plan = planOf({ usdt: 0, gate: 0, usdc: 11, usdcUpnl: 100, positionIm: 0 });
    expect(plan.routes.loop!.costUsd).toBeGreaterThan(plan.routes.convert.costUsd);
    expect(plan.routes.convert.steps[0]).toMatchObject({ kind: 'convert', move: 11, from: 'HYPERLIQUID', to: 'CROSSEX' });
    expect(plan.recommended).toBe('convert');
  });

  it('adds the spot taker fee to the loop cost', () => {
    const free = planOf(ACCOUNT_B).routes.loop!.costUsd;
    const taxed = planOf(ACCOUNT_B, { ...OPEN, spotTakerRate: 0.001 }).routes.loop!.costUsd;
    expect(taxed).toBeGreaterThan(free + 0.4);
  });
});

describe('planFor balanced', () => {
  it('under 1 is balanced', () => {
    const plan = planOf({ usdt: 500, gate: 0, usdc: 499.5, positionIm: 0 });
    expect(plan.balanced).toBe(true);
  });

  it('a balanced plan has no route to run', () => {
    const plan = planOf({ usdt: 500, gate: 0, usdc: 499.5, positionIm: 0 });
    expect(plan).toMatchObject({ moves: 0, shortOfEven: 0, recommended: null });
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.loop).toMatchObject({ available: false, reason: null, steps: [] });
    expect(plan.routes.convert).toMatchObject({ available: false, reason: null, steps: [] });
  });
});

describe('planFor blocked routes', () => {
  const paused: PlanInputs = { ...OPEN, coins: [{ ...USDC_RULE, isDisabled: 1 }] };

  it('paused transfers block the loop', () => {
    expect(planOf(ACCOUNT_A, paused).routes.loop!.reason).toBe('Gate paused USDC transfers.');
  });

  it('paused transfers recommend convert', () => {
    expect(planOf(ACCOUNT_A, paused).recommended).toBe('convert');
  });

  it('string is_disabled blocks the loop', () => {
    const inputs: PlanInputs = { ...OPEN, coins: [{ coin: 'USDC', minTransAmount: '11', estFee: '1', isDisabled: '1' }] };
    expect(planOf(ACCOUNT_A, inputs).routes.loop!.reason).toBe('Gate paused USDC transfers.');
  });

  it('paused transfers block the mix with the same reason', () => {
    const plan = planOf(EXAMPLE_D, paused);
    expect(plan.routes.mix).toMatchObject({ available: false, reason: 'Gate paused USDC transfers.' });
    expect(plan.routes.convert).toMatchObject({ available: true, reason: null });
    expect(plan.recommended).toBe('convert');
  });

  it('a spot market that is not live blocks the loop', () => {
    const plan = planOf(ACCOUNT_A, { ...OPEN, spotRule: { state: 'suspended' } });
    expect(plan.routes.loop).toMatchObject({ available: false, reason: 'The spot market for USDC is closed.' });
  });

  it('a missing spot price blocks the loop', () => {
    expect(planOf(ACCOUNT_A, { ...OPEN, ask: null }).routes.loop!.reason).toBe('The spot market for USDC is closed.');
    expect(planOf(EXAMPLE_E, { ...OPEN, bid: 0 }).routes.mix!.reason).toBe('The spot market for USDC is closed.');
  });

  it('paused transfers are named before a closed spot market', () => {
    const plan = planOf(ACCOUNT_A, { ...paused, spotRule: null });
    expect(plan.routes.loop!.reason).toBe('Gate paused USDC transfers.');
  });

  it('move under 11 closes the loop, which has no round to make', () => {
    const plan = planOf({ usdt: 510, gate: 0, usdc: 500, positionIm: 0 });
    expect(fit({ marginBalance: 1010, initialMargin: 0 }, 510)).toBeGreaterThan(11);
    expect(plan.routes.loop).toMatchObject({ available: false });
    expect(plan.routes.mix).toBeNull();
    expect(plan.recommended).toBe('convert');
  });

  it('no USDC coin rule leaves the loop open', () => {
    expect(planOf(ACCOUNT_A, { ...OPEN, coins: [] }).routes.loop).toMatchObject({ available: true, reason: null });
  });

  it('cash under 11 closes the loop, which has no round to make', () => {
    const plan = planOf({ usdt: 100, gate: 0, usdc: 8, usdcUpnl: 500, positionIm: 10 });
    expect(plan.routes.loop).toMatchObject({ available: false });
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.convert).toMatchObject({ available: true, reason: null });
    expect(plan.recommended).toBe('convert');
  });
});

describe('planFor loose Gate numbers', () => {
  it.each(['', '  ', 0, '0', 'n/a', -3])('a USDC minimum of %j falls back to 11 and never hangs the plan', (min) => {
    const plan = planOf(ACCOUNT_A_ROUND_3, { ...OPEN, coins: [{ ...USDC_RULE, minTransAmount: min }] });
    expect(plan.routes.loop).toMatchObject({ available: false });
    expect(plan.routes.convert).toMatchObject({ available: true, costUsd: 0.22 });
    const rounds = planOf(ACCOUNT_A, { ...OPEN, coins: [{ ...USDC_RULE, minTransAmount: min }] }).routes.loop!.steps;
    expect(rounds.map((step) => step.move)).toEqual([24.51, 29.93, 36.58, 44.71, 40.16]);
  });
});

interface Wallets3 {
  usdt: number;
  hyperliquid: number;
  lighter: number;
  gate?: number;
  usdtUpnl?: number;
  lighterUpnl?: number;
  positionIm: number;
}

function threeWallets(f: Wallets3): AccountLike {
  const marginBalance = f.usdt + (f.usdtUpnl ?? 0) + f.hyperliquid + f.lighter + (f.lighterUpnl ?? 0) + (f.gate ?? 0);
  const borrows = [f.usdt, f.hyperliquid, f.lighter].reduce((total, cash) => total + Math.max(0, -cash) / 5, 0);
  return {
    availableMargin: cents(marginBalance - f.positionIm - borrows),
    marginBalance: cents(marginBalance),
    initialMargin: cents(f.positionIm + borrows),
    assets: [
      wallet('USDT', 'CROSSEX', f.usdt, f.usdtUpnl),
      wallet('USDC', 'HYPERLIQUID', f.hyperliquid),
      wallet('USDC', 'LIGHTER', f.lighter, f.lighterUpnl),
      wallet('USDC', 'GATE', f.gate ?? 0),
    ],
  };
}

function splitPlan(f: Wallets3, notional: Record<string, number>) {
  const account = threeWallets(f);
  return planFor(bucketsFrom(account, BOTH_RATES, {}), account, { ...OPEN, notional });
}

const moveOf = (step: { from: string; to: string }) => `${step.from}>${step.to}`;

describe('notionalByWallet', () => {
  it('counts Hyperliquid and Lighter legs in their own USDC wallets and every other venue in USDT', () => {
    const legs = [
      { exchange: 'HYPERLIQUID', value: 1538.59 },
      { exchange: 'LIGHTER', value: 400 },
      { exchange: 'GATE', value: 1377.39 },
      { exchange: 'BINANCE', value: 124.07 },
      { exchange: 'LIGHTER', value: -100 },
    ];
    expect(notionalByWallet(legs)).toEqual({
      'USDC/HYPERLIQUID': 1538.59,
      'USDC/LIGHTER': 500,
      'USDT/CROSSEX': 1377.39 + 124.07,
    });
  });
});

describe('planFor split by notional', () => {
  it('Hyperliquid and Lighter each hedged against Gate at one size gives USDT 50, Hyperliquid 25, Lighter 25', () => {
    const plan = splitPlan(
      { usdt: 3000, hyperliquid: 0, lighter: 0, positionIm: 1200 },
      { 'USDT/CROSSEX': 20000, 'USDC/HYPERLIQUID': 10000, 'USDC/LIGHTER': 10000 },
    );
    expect(plan.split.map((row) => [row.venue, row.share])).toEqual([
      ['CROSSEX', 0.5],
      ['HYPERLIQUID', 0.25],
      ['LIGHTER', 0.25],
    ]);
    expect(plan.routes.convert.steps.map(moveOf)).toEqual(['CROSSEX>HYPERLIQUID', 'CROSSEX>LIGHTER']);
    for (const route of [plan.routes.loop!, plan.routes.convert]) {
      const usdt = walletIn(route.after, 'USDT', 'CROSSEX').equity;
      expect(Math.abs(walletIn(route.after, 'USDC', 'HYPERLIQUID').equity - usdt / 2)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(walletIn(route.after, 'USDC', 'LIGHTER').equity - usdt / 2)).toBeLessThanOrEqual(0.05);
    }
  });

  it('one job makes both moves: a Lighter round pays 1.03 and takes 235 s', () => {
    const plan = splitPlan(
      { usdt: 3000, hyperliquid: 0, lighter: 0, positionIm: 1200 },
      { 'USDT/CROSSEX': 20000, 'USDC/HYPERLIQUID': 10000, 'USDC/LIGHTER': 10000 },
    );
    expect(plan.recommended).toBe('loop');
    expect(plan.routes.loop!.steps).toEqual([
      expect.objectContaining({ round: 1, from: 'CROSSEX', to: 'HYPERLIQUID', move: 749.73, arrives: 749.68, seconds: 130 }),
      expect.objectContaining({ round: 2, from: 'CROSSEX', to: 'LIGHTER', move: 750.71, arrives: 749.68, seconds: 235 }),
    ]);
    expect(plan.routes.loop).toMatchObject({ costUsd: 1.23, seconds: 365, rounds: 2 });
  });

  it('a larger Hyperliquid leg takes a larger share', () => {
    const plan = splitPlan(
      { usdt: 3000, hyperliquid: 0, lighter: 0, positionIm: 1200 },
      { 'USDT/CROSSEX': 30000, 'USDC/HYPERLIQUID': 20000, 'USDC/LIGHTER': 10000 },
    );
    const after = plan.routes.convert.after;
    expect(walletIn(after, 'USDC', 'HYPERLIQUID').equity / walletIn(after, 'USDC', 'LIGHTER').equity).toBeCloseTo(2, 2);
    expect(walletIn(after, 'USDT', 'CROSSEX').equity / walletIn(after, 'USDC', 'LIGHTER').equity).toBeCloseTo(3, 2);
  });

  it('a wallet with no open legs empties into the wallet with legs', () => {
    const plan = splitPlan(
      { usdt: 2000, hyperliquid: 1000, lighter: 0, positionIm: 400 },
      { 'USDT/CROSSEX': 5000, 'USDC/LIGHTER': 5000 },
    );
    expect(plan.split.find((row) => row.venue === 'HYPERLIQUID')).toMatchObject({ notionalUsd: 0, share: 0 });
    expect(plan.routes.convert.steps.map(moveOf)).toEqual(['HYPERLIQUID>LIGHTER', 'CROSSEX>LIGHTER']);
    expect(plan.routes.mix!.steps.map((step) => `${step.kind} ${moveOf(step)}`)).toEqual([
      'round HYPERLIQUID>LIGHTER',
      'convert CROSSEX>LIGHTER',
    ]);
    for (const route of [plan.routes.mix!, plan.routes.convert]) {
      expect(walletIn(route.after, 'USDC', 'HYPERLIQUID').equity).toBeLessThan(DUST);
      const usdt = walletIn(route.after, 'USDT', 'CROSSEX').equity;
      expect(Math.abs(walletIn(route.after, 'USDC', 'LIGHTER').equity - usdt)).toBeLessThanOrEqual(0.05);
    }
  });

  it('Hyperliquid to Lighter goes through Gate spot with no sale and pays both fees', () => {
    const plan = splitPlan(
      { usdt: 0, hyperliquid: 1300, lighter: 100, positionIm: 200 },
      { 'USDC/HYPERLIQUID': 5000, 'USDC/LIGHTER': 5000 },
    );
    expect(plan.routes.loop!.steps).toEqual([
      expect.objectContaining({ kind: 'round', buy: 0, from: 'HYPERLIQUID', to: 'LIGHTER', move: 601.01, arrives: 598.98, seconds: 625 }),
    ]);
    expect(plan.routes.loop!.costUsd).toBe(2.03);
    expect(plan.routes.convert.steps).toEqual([
      expect.objectContaining({ kind: 'convert', from: 'HYPERLIQUID', to: 'LIGHTER', move: 601.26, arrives: 598.73 }),
    ]);
    expect(plan.routes.convert.costUsd).toBe(2.52);
    expect(plan.recommended).toBe('loop');
  });

  it('a 400 Hyperliquid to Lighter move recommends Convert, because the 2.03 round costs more than 1.68', () => {
    const plan = splitPlan(
      { usdt: 0, hyperliquid: 900, lighter: 100, positionIm: 200 },
      { 'USDC/HYPERLIQUID': 5000, 'USDC/LIGHTER': 5000 },
    );
    expect(plan.routes.loop!.costUsd).toBe(2.03);
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.convert.costUsd).toBe(1.68);
    expect(plan.recommended).toBe('convert');
  });

  it.each([
    { hyperliquid: 1068, convert: 2.03, loop: 2.03, recommended: 'convert' },
    { hyperliquid: 1069, convert: 2.04, loop: 2.03, recommended: 'loop' },
  ])('a Spot loop that costs the same as Convert is not the pick, and one cent less makes it so (Hyperliquid $hyperliquid)', (row) => {
    const plan = splitPlan(
      { usdt: 0, hyperliquid: row.hyperliquid, lighter: 100, positionIm: 200 },
      { 'USDC/HYPERLIQUID': 5000, 'USDC/LIGHTER': 5000 },
    );
    expect(plan.routes.convert.costUsd).toBe(row.convert);
    expect(plan.routes.loop?.costUsd ?? null).toBe(row.loop);
    expect(plan.routes.mix).toBeNull();
    expect(plan.recommended).toBe(row.recommended);
  });

  it('Lighter to Hyperliquid pays only the 0.05 Hyperliquid fee', () => {
    const plan = splitPlan(
      { usdt: 0, hyperliquid: 100, lighter: 900, positionIm: 200 },
      { 'USDC/HYPERLIQUID': 5000, 'USDC/LIGHTER': 5000 },
    );
    expect(plan.routes.loop!.steps).toEqual([
      expect.objectContaining({ from: 'LIGHTER', to: 'HYPERLIQUID', move: 400.02, arrives: 399.97, seconds: 305 }),
    ]);
    expect(plan.routes.loop!.costUsd).toBe(0.05);
    expect(plan.recommended).toBe('loop');
  });

  it('a Hyperliquid to Lighter round is at least 12, so an 11 move has no round and the loop closes', () => {
    const plan = splitPlan(
      { usdt: 0, hyperliquid: 521, lighter: 500, positionIm: 0 },
      { 'USDC/HYPERLIQUID': 5000, 'USDC/LIGHTER': 5000 },
    );
    expect(plan.routes.loop).toMatchObject({ available: false });
    expect(plan.routes.mix).toBeNull();
    expect(plan.recommended).toBe('convert');
  });

  it('Convert closes while USDT cash is under -1 and a Hyperliquid to Lighter swap is needed, and the Spot loop row stays open', () => {
    const plan = splitPlan(
      { usdt: -10, hyperliquid: 600, lighter: 0, positionIm: 150 },
      { 'USDT/CROSSEX': 100, 'USDC/HYPERLIQUID': 1000, 'USDC/LIGHTER': 1000 },
    );
    expect(plan.balanced).toBe(false);
    expect(plan.routes.convert).toMatchObject({
      available: false,
      reason: 'A Convert between Hyperliquid and Lighter needs USDT · CrossEx cash of -1 or more.',
    });
    expect(plan.routes.convert.steps.map(moveOf)).toEqual(['HYPERLIQUID>LIGHTER', 'HYPERLIQUID>CROSSEX']);
    expect(plan.routes.loop).not.toBeNull();
    expect(plan.routes.mix!.steps.map((step) => `${step.kind} ${moveOf(step)}`)).toEqual([
      'round HYPERLIQUID>LIGHTER',
      'convert HYPERLIQUID>CROSSEX',
    ]);
    expect(plan.routes.mix!.available).toBe(true);
    expect(plan.recommended).toBe('mix');
  });

  it('USDT cash a few cents under 0 keeps Convert open', () => {
    const plan = splitPlan(
      { usdt: -0.01, hyperliquid: 900, lighter: 100, positionIm: 150 },
      { 'USDT/CROSSEX': 100, 'USDC/HYPERLIQUID': 1000, 'USDC/LIGHTER': 1000 },
    );
    expect(plan.routes.convert.available).toBe(true);
    expect(plan.routes.convert.steps.map(moveOf)).toContain('HYPERLIQUID>LIGHTER');
    expect(plan.recommended).toBe('convert');
  });

  it('Spot loop closes too while USDT cash is under -1 and its last Lighter to Hyperliquid move is a Convert', () => {
    const plan = splitPlan(
      { usdt: -2.08, hyperliquid: 0, lighter: 24.37, gate: 3.43, positionIm: 8.16 },
      { 'USDT/CROSSEX': 484.66, 'USDC/HYPERLIQUID': 11287.38, 'USDC/LIGHTER': 1990.48 },
    );
    expect(plan.routes.loop!.steps.map((step) => `${step.kind} ${moveOf(step)}`)).toEqual([
      'round LIGHTER>HYPERLIQUID',
      'convert LIGHTER>HYPERLIQUID',
    ]);
    expect(plan.routes.loop).toMatchObject({ available: false, reason: 'A Convert between Hyperliquid and Lighter needs USDT · CrossEx cash of -1 or more.' });
    expect(plan.recommended).toBeNull();
  });

  it('with Convert closed, the capped mix closes with the USDT reason and the loop over 15 min is not the pick', () => {
    const plan = splitPlan(
      { usdt: -10, hyperliquid: 1000, lighter: 0, positionIm: 800 },
      { 'USDT/CROSSEX': 100, 'USDC/HYPERLIQUID': 1000, 'USDC/LIGHTER': 1000 },
    );
    const reason = 'A Convert between Hyperliquid and Lighter needs USDT · CrossEx cash of -1 or more.';
    expect(plan.routes.loop).not.toBeNull();
    expect(plan.routes.mix).toMatchObject({ available: false, reason, rounds: 1 });
    expect(plan.routes.mix!.seconds).toBeLessThanOrEqual(900);
    expect(plan.routes.convert).toMatchObject({ available: false, reason });
    expect(plan.recommended).toBeNull();
    expect(plan.balanced).toBe(false);
    // With nothing recommended the amount is the first OPEN route's, the loop, not Convert's 529.57.
    expect(plan.moves).toBe(534.84);
  });

  it('USDT cash under -1 keeps a Convert from Lighter to USDT open when nothing swaps between Hyperliquid and Lighter', () => {
    const plan = splitPlan(
      { usdt: -3000, usdtUpnl: 3500, hyperliquid: 0, lighter: 2000, lighterUpnl: 1000, positionIm: 3120 },
      { 'USDT/CROSSEX': 30000, 'USDC/HYPERLIQUID': 5000 },
    );
    expect(plan.routes.convert).toMatchObject({ available: true, reason: null });
    expect(plan.routes.convert.steps.map(moveOf)).toEqual(['LIGHTER>CROSSEX']);
    expect(plan.recommended).toBe('convert');
  });

  it('a move under 11 next to a move that loops closes the loop and leaves the mix as the pick', () => {
    const plan = splitPlan(
      { usdt: 476, hyperliquid: 478, lighter: 24.5, positionIm: 150 },
      { 'USDT/CROSSEX': 1672, 'USDC/HYPERLIQUID': 1709 },
    );
    expect(plan.routes.loop).toMatchObject({ available: false });
    expect(plan.routes.mix?.steps.map((step) => `${step.kind} ${moveOf(step)}`)).toEqual([
      'round LIGHTER>HYPERLIQUID',
      'convert LIGHTER>CROSSEX',
    ]);
    expect(plan.recommended).toBe('mix');
  });

  it('with no open legs there is nothing to rebalance', () => {
    const plan = splitPlan({ usdt: 1000, hyperliquid: 0, lighter: 0, positionIm: 0 }, {});
    expect(plan).toMatchObject({ balanced: true, noLegs: true, moves: 0, shortOfEven: 0, recommended: null });
    expect(plan.routes.loop!.steps).toEqual([]);
    expect(plan.routes.convert.steps).toEqual([]);
  });

  it('a Lighter wallet under 1 with no legs stays out of the split', () => {
    const plain = planOf({ usdt: 1000, gate: 0, usdc: 200, positionIm: 100 });
    const withDust = splitPlan(
      { usdt: 1000, hyperliquid: 200, lighter: -0.5, positionIm: 100 },
      { 'USDT/CROSSEX': 1000, 'USDC/HYPERLIQUID': 1000 },
    );
    expect(withDust.split.map((row) => row.venue)).toEqual(['CROSSEX', 'HYPERLIQUID']);
    expect(withDust.routes.loop!.steps.map((step) => step.move)).toEqual(plain.routes.loop!.steps.map((step) => step.move));
  });

  it('a spot market that is closed does not block a move between the two USDC wallets', () => {
    const plan = planFor(
      bucketsFrom(threeWallets({ usdt: 0, hyperliquid: 100, lighter: 900, positionIm: 200 }), BOTH_RATES, {}),
      threeWallets({ usdt: 0, hyperliquid: 100, lighter: 900, positionIm: 200 }),
      { ...OPEN, spotRule: null, ask: null, bid: null, notional: { 'USDC/HYPERLIQUID': 5000, 'USDC/LIGHTER': 5000 } },
    );
    expect(plan.routes.loop).toMatchObject({ available: true, reason: null });
  });
});

describe('spotOrderMax', () => {
  it('caps one order at 4,896,572.39 USDC at ask 1.0007', () => {
    expect(spotOrderMax(1.0007)).toBe(4896572.39);
  });

  it('caps one order at 4,757,281.55 USDC at price 1.03', () => {
    expect(spotOrderMax(1.03)).toBe(4757281.55);
  });

  it('keeps the 4,900,000 ceiling at price 0.99', () => {
    expect(SPOT_ORDER_MAX_USDC).toBe(4900000);
    expect(spotOrderMax(0.99)).toBe(4900000);
  });

  it('caps one order at 3,920,000 under a CrossEx rule max of 4,000,000', () => {
    expect(spotOrderMax(1, 4000000)).toBe(3920000);
  });

  it.each([NaN, 0, -1, Infinity])('counts price %s as 1', (price) => {
    expect(spotOrderMax(price)).toBe(4900000);
  });

  it.each([null, undefined, NaN, 0, -5])('ignores a rule max of %s', (max) => {
    expect(spotOrderMax(1, max)).toBe(4900000);
  });
});

const SPREAD: PlanInputs = { ...OPEN, spotTakerRate: 0, ask: 1.0007, bid: 1.0006 };

function scalePlan(f: Wallets3, notional: Record<string, number>, inputs: Partial<PlanInputs> = {}) {
  const account = threeWallets(f);
  return planFor(bucketsFrom(account, BOTH_RATES, {}), account, { ...SPREAD, ...inputs, notional });
}

const routesOf = (plan: EvenPlan): RoutePlan[] =>
  [plan.routes.mix, plan.routes.loop, plan.routes.convert].filter((route): route is RoutePlan => route !== null);

const roundsOf = (plan: EvenPlan): PlannedStep[] =>
  routesOf(plan).flatMap((route) => route.steps.filter((step) => step.kind === 'round'));

const movedBy = (route: RoutePlan): number => route.steps.reduce((total, step) => total + step.move, 0);

describe('planFor at $6,000,000 keeps every Buy and Sell USDC under the order cap', () => {
  const cap = spotOrderMax(1.0007);

  it('S1: $6,000,000 USDT with every leg on Hyperliquid buys at most 4,896,572.39 a round and still ends even', () => {
    const plan = scalePlan(
      { usdt: 6_000_000, hyperliquid: 0, lighter: 0, positionIm: 600_000 },
      { 'USDC/HYPERLIQUID': 6_000_000 },
      { spotTakerRate: 0.001 },
    );
    const loop = plan.routes.loop!;
    expect(plan.recommended).toBe('loop');
    expect(loop.steps[0]).toMatchObject({ kind: 'round', buy: 4896572.39, move: 4896572.39 });
    expect(loop.steps.filter((step) => step.kind === 'round').length).toBeGreaterThanOrEqual(2);
    expect(loop.seconds).toBeLessThanOrEqual(900);
    for (const step of roundsOf(plan)) {
      expect(step.buy).toBeLessThanOrEqual(cap);
      expect(step.move).toBeLessThanOrEqual(cap);
    }
    const usdt = walletIn(loop.after, 'USDT', 'CROSSEX');
    expect(usdt.cash).toBeGreaterThanOrEqual(0);
    expect(usdt.equity).toBeLessThan(DUST);
    expect(walletIn(loop.after, 'USDC', 'HYPERLIQUID').equity).toBeGreaterThan(6_000_000 * (1 - 0.0018));
    expect(plan.shortOfEven).toBe(0);
  });

  it('S2: $6,000,000 on Hyperliquid with every leg on Gate sells 4,896,572.39 then 1,103,427.60', () => {
    const plan = scalePlan(
      { usdt: 0, hyperliquid: 6_000_000, lighter: 0, positionIm: 600_000 },
      { 'USDT/CROSSEX': 6_000_000 },
      { spotTakerRate: 0.001 },
    );
    const loop = plan.routes.loop!;
    expect(plan.recommended).toBe('loop');
    expect(loop.steps.map((step) => [step.kind, step.buy, step.move])).toEqual([
      ['round', 0, 4896572.39],
      ['round', 0, 1103427.6],
    ]);
    expect(loop.seconds).toBe(800);
    expect(walletIn(loop.after, 'USDC', 'HYPERLIQUID').equity).toBeLessThan(DUST);
    expect(walletIn(loop.after, 'USDC', 'GATE').cash).toBe(0);
    expect(plan.shortOfEven).toBe(0);
  });

  it('$6,000,000 of USDC · Gate cash moves to Hyperliquid in rounds of at most 4,896,572.39 and buys nothing', () => {
    const plan = scalePlan(
      { usdt: 0, hyperliquid: 0, lighter: 0, gate: 6_000_000, positionIm: 600_000 },
      { 'USDC/HYPERLIQUID': 6_000_000 },
    );
    expect(plan.routes.loop!.steps.map((step) => [step.buy, step.move])).toEqual([
      [0, 4896572.39],
      [0, 1103427.6],
    ]);
    expect(walletIn(plan.routes.loop!.after, 'USDC', 'GATE').cash).toBeLessThan(DUST);
  });

  it('$6,000,000 of USDC · Gate cash sold next to a $1,000,000 Hyperliquid round costs what one sale would', () => {
    const plan = scalePlan(
      { usdt: 0, hyperliquid: 1_000_000, lighter: 0, gate: 6_000_000, positionIm: 700_000 },
      { 'USDT/CROSSEX': 6_000_000 },
      { ask: 1.0001, bid: 0.9999 },
    );
    const loop = plan.routes.loop!;
    const sold = 999998.99 + 6_000_000;
    expect(sold).toBeGreaterThan(spotOrderMax(1.0001));
    expect(loop.steps).toEqual([expect.objectContaining({ kind: 'round', move: 999999.99, arrives: 999998.99 })]);
    expect(loop.costUsd).toBe(Number(cents(HYPERLIQUID_WITHDRAW_FEE_USD + sold * 0.0001)));
    expect(walletIn(loop.after, 'USDT', 'CROSSEX').cash).toBe(6999298.99);
    expect(walletIn(loop.after, 'USDC', 'GATE').cash).toBe(0);
  });

  it('at price 1.03 no $6,000,000 round passes 4,757,281.55', () => {
    const cap103 = spotOrderMax(1.03);
    const prices = { ask: 1.03, bid: 1.0299 };
    const buy = scalePlan({ usdt: 6_000_000, hyperliquid: 0, lighter: 0, positionIm: 600_000 }, { 'USDC/HYPERLIQUID': 6_000_000 }, prices);
    const sell = scalePlan({ usdt: 0, hyperliquid: 6_000_000, lighter: 0, positionIm: 600_000 }, { 'USDT/CROSSEX': 6_000_000 }, prices);
    for (const step of [...roundsOf(buy), ...roundsOf(sell)]) {
      expect(step.buy).toBeLessThanOrEqual(cap103);
      expect(step.move).toBeLessThanOrEqual(cap103);
    }
    expect(buy.recommended).toBe('loop');
    expect(sell.routes.loop!.steps.map((step) => step.move)).toEqual([4757281.55, 1242718.44]);
  });

  it('a CrossEx rule max of 4,000,000 caps each $6,000,000 round at 3,920,000', () => {
    const plan = scalePlan(
      { usdt: 0, hyperliquid: 6_000_000, lighter: 0, positionIm: 600_000 },
      { 'USDT/CROSSEX': 6_000_000 },
      { spotRule: { state: 'live', maxMarketSize: '4000000' } },
    );
    expect(plan.routes.loop!.steps.map((step) => step.move)).toEqual([3920000, 2079999.99]);
  });

  it.each([
    { hyperliquid: 4_900_000.01, shown: 'loop', kinds: ['round'] },
    { hyperliquid: 4_900_000.02, shown: 'loop', kinds: ['round'] },
    { hyperliquid: 4_900_000.5, shown: 'mix', kinds: ['round', 'convert'] },
  ])('$hyperliquid on Hyperliquid at price 1 shows the $shown row with no round over 4,900,000', (row) => {
    const plan = scalePlan(
      { usdt: 0, hyperliquid: row.hyperliquid, lighter: 0, positionIm: 0 },
      { 'USDT/CROSSEX': 1 },
      { ask: 1, bid: 1 },
    );
    const route = row.shown === 'mix' ? plan.routes.mix! : plan.routes.loop!;
    expect(route.steps.map((step) => step.kind)).toEqual(row.kinds);
    for (const step of roundsOf(plan)) expect(step.move).toBeLessThanOrEqual(SPOT_ORDER_MAX_USDC);
    expect(route.steps[0].move).toBeGreaterThanOrEqual(4_899_999.99);
    expect(movedBy(route)).toBeCloseTo(plan.moves, 2);
    expect(plan.moves).toBeGreaterThanOrEqual(row.hyperliquid - 0.03);
  });
});

describe('planFor never plans a Buy USDC with more USDT than the wallet holds', () => {
  it('$6,000,000 USDT with no USDT legs and upnl 0 ends at USDT cash and equity of 0 to 1', () => {
    const plan = scalePlan({ usdt: 6_000_000, hyperliquid: 0, lighter: 0, positionIm: 600_000 }, { 'USDC/HYPERLIQUID': 6_000_000 });
    for (const route of routesOf(plan)) {
      const usdt = walletIn(route.after, 'USDT', 'CROSSEX');
      expect(usdt.cash).toBeGreaterThanOrEqual(0);
      expect(usdt.equity).toBeGreaterThanOrEqual(0);
      expect(usdt.equity).toBeLessThan(DUST);
    }
    expect(walletIn(plan.routes.loop!.after, 'USDC', 'HYPERLIQUID').equity).toBe(5995802.82);
  });

  it('$5,000,000 USDT cash with 1,000,000 upnl ends at USDT cash 0, not -3,500', () => {
    const plan = scalePlan(
      { usdt: 5_000_000, usdtUpnl: 1_000_000, hyperliquid: 1_000_000, lighter: 0, positionIm: 600_000 },
      { 'USDC/HYPERLIQUID': 6_000_000, 'USDT/CROSSEX': 60_000 },
    );
    for (const route of routesOf(plan)) {
      expect(walletIn(route.after, 'USDT', 'CROSSEX').cash).toBeGreaterThanOrEqual(0);
      for (const step of route.steps) expect(step.buy).toBeLessThanOrEqual(spotOrderMax(1.0007));
    }
    const usdt = walletIn(plan.routes.loop!.after, 'USDT', 'CROSSEX');
    expect(usdt.cash).toBeLessThan(DUST);
    expect(usdt.equity).toBeGreaterThanOrEqual(1_000_000 - DUST);
  });
});

const RUNGS = [50, 5_000, 100_000, 1_000_000, 6_000_000];
const HAIR = 0.000001;
const KEPT = 1 - CONVERT_RATE;

interface Prices {
  ask: number;
  bid: number;
}

function convertKept(step: Pick<PlannedStep, 'from' | 'to'>, prices: Prices): number {
  if (step.from === 'CROSSEX') return KEPT / prices.ask;
  if (step.to === 'CROSSEX') return KEPT * prices.bid;
  return (KEPT * KEPT * prices.bid) / prices.ask;
}

const convertCostOf = (step: PlannedStep, prices: Prices): number =>
  step.move - step.move * convertKept(step, { ask: Math.max(1, prices.ask), bid: Math.min(1, prices.bid) });

function expectedCost(route: RoutePlan): number {
  return route.steps.reduce((total, step) => {
    if (step.kind === 'convert') return total + convertCostOf(step, { ask: SPREAD.ask!, bid: SPREAD.bid! });
    if (step.from === 'CROSSEX') return total + step.buy * (SPREAD.ask! - 1) + HYPERLIQUID_DEPOSIT_FEE_USD;
    return total + step.arrives * Math.max(0, 1 - SPREAD.bid!) + HYPERLIQUID_WITHDRAW_FEE_USD;
  }, 0);
}

interface LadderCase {
  name: string;
  cash: number;
  wallets: { usdt: number; hyperliquid: number };
  notional: Record<string, number>;
}

describe('planFor size ladder at ask 1.0007, bid 1.0006 and spot taker 0', () => {
  const cases = RUNGS.flatMap((rung) => [rung, rung - HAIR]).flatMap((cash): LadderCase[] => [
    {
      name: `toward USDC with ${cash} USDT`,
      cash,
      wallets: { usdt: cash, hyperliquid: 0 },
      notional: { 'USDC/HYPERLIQUID': cash },
    },
    {
      name: `toward USDT with ${cash} USDC on Hyperliquid`,
      cash,
      wallets: { usdt: 0, hyperliquid: cash },
      notional: { 'USDT/CROSSEX': cash },
    },
  ]);

  it.each(cases)('$name', (row) => {
    const plan = scalePlan({ ...row.wallets, lighter: 0, positionIm: row.cash / 10 }, row.notional);
    const cap = spotOrderMax(1.0007);
    expect(plan.balanced).toBe(false);
    for (const route of routesOf(plan)) {
      expect(movedBy(route)).toBeLessThanOrEqual(row.cash);
      for (const step of route.steps) {
        expect(step.move).toBeLessThanOrEqual(row.cash);
        if (step.kind !== 'round') continue;
        expect(step.buy).toBeLessThanOrEqual(cap);
        expect(step.move).toBeLessThanOrEqual(cap);
      }
      const usdt = walletIn(route.after, 'USDT', 'CROSSEX');
      expect(usdt.cash).toBeGreaterThanOrEqual(0);
      expect(usdt.equity).toBeGreaterThanOrEqual(0);
      const expected = expectedCost(route);
      expect(Math.abs(route.costUsd - expected)).toBeLessThanOrEqual(Math.max(0.005 * expected, 0.01));
    }
    const convert = plan.routes.convert;
    expect(convert.steps).toHaveLength(1);
    expect(Math.abs(convert.costUsd - convertCostOf(convert.steps[0], { ask: SPREAD.ask!, bid: SPREAD.bid! }))).toBeLessThanOrEqual(0.01);
  });
});

describe('planFor solve time on a large Lighter wallet', () => {
  function lighterBook(usdt: number, lighter: number, free: number, spotTakerRate: number) {
    const marginBalance = usdt + lighter;
    const account: AccountLike = {
      availableMargin: '0',
      marginBalance: String(marginBalance),
      initialMargin: String((marginBalance - free) / 1.12),
      assets: [
        asset('USDT', 'CROSSEX', { balance: usdt, equity: usdt }),
        asset('USDC', 'LIGHTER', { balance: lighter, equity: lighter }),
      ],
    };
    const notional = { 'USDT/CROSSEX': 30_000_000, 'USDC/LIGHTER': 30_000_000 };
    const started = performance.now();
    const plan = planFor(bucketsFrom(account, [], {}), account, { ...SPREAD, spotTakerRate, notional });
    return { plan, ms: performance.now() - started };
  }

  it.each([
    { name: '$6,000,000 at free margin 12 and spot taker 0.0002', usdt: 2_000_000, lighter: 6_000_000, taker: 0.0002 },
    { name: '$3,000,000 at free margin 12 and spot taker 0', usdt: 1_000_000, lighter: 3_000_000, taker: 0 },
  ])('plans $name in under 250 ms', (row) => {
    const { plan, ms } = lighterBook(row.usdt, row.lighter, 12, row.taker);
    expect(ms).toBeLessThan(250);
    expect(plan.balanced).toBe(false);
    expect(plan.recommended).not.toBeNull();
    expect(plan.routes[plan.recommended!]!.seconds).toBeLessThanOrEqual(900);
  });
});

const BOOK_READ = bookLevels(
  JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/gate/spot-order-book-usdc-usdt.json'), 'utf8')),
);
const TOP = { ask: 1.0008, bid: 1.0007 };
const DEPTH = { ...TOP, ...BOOK_READ };
const BOOKED: Partial<PlanInputs> = { ...TOP, ...BOOK_READ };

const WALKS: [number, number, number][] = [
  [50, 50.04, 50.035],
  [5_000, 5_004, 5_003.5],
  [100_000, 100_080, 100_070],
  [1_000_000, 1_000_800, 1_000_650.36],
  [4_900_000, 4_904_935.4237, 4_901_987.1879],
  [6_000_000, 6_006_365.4237, 6_002_207.1879],
];

describe('buyCostUsdt and sellProceedsUsdt on the Gate USDC_USDT book read at 2026-09-16T18:37:43Z', () => {
  it.each(WALKS.flatMap(([usdc, buy, sell]) => [[usdc, buy, sell], [usdc - HAIR, buy, sell]]))(
    'a market order of %d USDC buys for %d USDT and sells for %d USDT',
    (usdc, buy, sell) => {
      expect(Math.abs(buyCostUsdt(usdc, DEPTH) - buy)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(sellProceedsUsdt(usdc, DEPTH) - sell)).toBeLessThanOrEqual(0.01);
    },
  );

  it.each([100_000, 1_000_000])('a Buy of %d USDC pays the top ask on every unit', (usdc) => {
    expect(buyCostUsdt(usdc, DEPTH)).toBeCloseTo(usdc * TOP.ask, 6);
  });

  it('a Sell of 100,000 USDC gets the top bid on every unit, and 1,000,000 gets 49.64 less because the top bid holds 805,796.27', () => {
    expect(sellProceedsUsdt(100_000, DEPTH)).toBeCloseTo(100_000 * TOP.bid, 6);
    expect(1_000_000 * TOP.bid - sellProceedsUsdt(1_000_000, DEPTH)).toBeCloseTo(49.64, 2);
  });

  it('a Buy past the first ask level of 2,532,008.17 pays 1.0009 for the part past it', () => {
    const level = 2_532_008.17;
    expect(buyCostUsdt(level - HAIR, DEPTH)).toBeCloseTo((level - HAIR) * TOP.ask, 6);
    expect(buyCostUsdt(level, DEPTH)).toBeCloseTo(level * TOP.ask, 6);
    expect(buyCostUsdt(level + 0.01, DEPTH) - buyCostUsdt(level, DEPTH)).toBeCloseTo(0.01 * 1.0009, 6);
  });

  it.each(RUNGS.flatMap((rung) => [rung, rung - HAIR]))('buyableUsdc gives back %d USDC from its walked cost', (usdc) => {
    expect(Math.abs(buyableUsdc(buyCostUsdt(usdc, DEPTH), DEPTH) - usdc)).toBeLessThanOrEqual(0.000001);
  });

  it('with no levels a 6,000,000 order is priced at the top price alone', () => {
    const empty = { ...TOP, asks: [], bids: [] };
    expect(buyCostUsdt(6_000_000, empty)).toBe(6_000_000 * TOP.ask);
    expect(sellProceedsUsdt(6_000_000, empty)).toBe(6_000_000 * TOP.bid);
    expect(buyableUsdc(6_000_000, empty)).toBe(6_000_000 / TOP.ask);
  });

  it('a book that holds 3,000,000 prices the rest of a 6,000,000 order at its last level and flags the plan', () => {
    const thin: { asks: BookLevel[]; bids: BookLevel[] } = {
      asks: [[1.0008, 1_000_000], [1.001, 2_000_000]],
      bids: [[1.0007, 1_000_000], [1.0005, 2_000_000]],
    };
    expect(buyCostUsdt(6_000_000, { ...TOP, asks: thin.asks })).toBeCloseTo(1_000_800 + 5_005_000, 6);
    expect(sellProceedsUsdt(6_000_000, { ...TOP, bids: thin.bids })).toBeCloseTo(1_000_700 + 5_002_500, 6);
    expect(buyableUsdc(1_000_800 + 5_005_000, { ...TOP, asks: thin.asks })).toBeCloseTo(6_000_000, 6);
    const whale = { usdt: 6_000_000, hyperliquid: 0, lighter: 0, positionIm: 600_000 };
    const buys = scalePlan(whale, { 'USDC/HYPERLIQUID': 6_000_000 }, { ...TOP, ...thin });
    const sells = scalePlan({ ...whale, usdt: 0, hyperliquid: 6_000_000 }, { 'USDT/CROSSEX': 6_000_000 }, { ...TOP, ...thin });
    expect(buys.routes.loop!.beyondBook).toBe(true);
    expect(sells.routes.loop!.beyondBook).toBe(true);
    expect(scalePlan(whale, { 'USDC/HYPERLIQUID': 6_000_000 }, BOOKED).routes.loop!.beyondBook).toBe(false);
  });

  it('bookLevels keeps only levels with a positive price and size', () => {
    const levels = bookLevels({ asks: [['1.0008', '5'], ['x', '1'], ['1.0009', '-1'], 'bad', ['1.001', '2']], bids: 'none' });
    expect(levels).toEqual({ asks: [[1.0008, 5], [1.001, 2]], bids: [] });
    expect(bookLevels(null)).toEqual({ asks: [], bids: [] });
  });
});

describe('planFor with no book levels is the plan priced at the top price', () => {
  const noBook = { asks: [], bids: [] };
  it.each([ACCOUNT_A, ACCOUNT_A_ROUND_3, ACCOUNT_B, EXAMPLE_C, EXAMPLE_D, EXAMPLE_E, THIN_MARGIN])('book %#', (f) => {
    const plan = planOf(f, OPEN);
    expect(planOf(f, { ...OPEN, ...noBook })).toEqual(plan);
    for (const route of routesOf(plan)) expect(route.beyondBook).toBe(false);
  });

  it.each<{ usdt: number; hyperliquid: number; notional: Record<string, number> }>([
    { usdt: 6_000_000, hyperliquid: 0, notional: { 'USDC/HYPERLIQUID': 6_000_000 } },
    { usdt: 0, hyperliquid: 6_000_000, notional: { 'USDT/CROSSEX': 6_000_000 } },
  ])('the $6,000,000 book with $usdt USDT and $hyperliquid on Hyperliquid', (row) => {
    const wallets = { usdt: row.usdt, hyperliquid: row.hyperliquid, lighter: 0, positionIm: 600_000 };
    expect(scalePlan(wallets, row.notional, noBook)).toEqual(scalePlan(wallets, row.notional));
  });
});

describe('planFor at $6,000,000 prices each round from the book', () => {
  const whale = { usdt: 6_000_000, hyperliquid: 0, lighter: 0, positionIm: 600_000 };
  const roundSteps = (route: RoutePlan) => route.steps.filter((step) => step.kind === 'round');
  const convertCost = (route: RoutePlan) =>
    route.steps.filter((step) => step.kind === 'convert').reduce((total, step) => total + convertCostOf(step, TOP), 0);

  it('S1: a $6,000,000 Spot loop out of USDT costs the top-price cost plus the walked extra of each Buy', () => {
    const plan = scalePlan(whale, { 'USDC/HYPERLIQUID': 6_000_000 }, BOOKED);
    const loop = plan.routes.loop!;
    const buys = roundSteps(loop).map((step) => step.buy);
    const extra = buys.reduce((total, buy) => total + buyCostUsdt(buy, DEPTH) - buy * TOP.ask, 0);
    const topCost = buys.reduce((total, buy) => total + HYPERLIQUID_DEPOSIT_FEE_USD + buy * (TOP.ask - 1), convertCost(loop));
    expect(plan.recommended).toBe('loop');
    expect(buys[0]).toBe(spotOrderMax(TOP.ask));
    expect(extra).toBeGreaterThan(1_000);
    expect(Math.abs(loop.costUsd - topCost - extra)).toBeLessThanOrEqual(1);
    expect(loop.costUsd).toBeGreaterThan(scalePlan(whale, { 'USDC/HYPERLIQUID': 6_000_000 }, TOP).routes.loop!.costUsd + 1_000);
  });

  it('S1: every planned Buy walked through the book costs no more than the USDT cash', () => {
    const plan = scalePlan(whale, { 'USDC/HYPERLIQUID': 6_000_000 }, { ...BOOKED, spotTakerRate: 0.001 });
    for (const route of routesOf(plan)) {
      const spent = roundSteps(route).reduce((total, step) => total + buyCostUsdt(step.buy, DEPTH) * 1.001, 0);
      expect(spent).toBeLessThanOrEqual(6_000_000);
      expect(walletIn(route.after, 'USDT', 'CROSSEX').cash).toBeGreaterThanOrEqual(0);
    }
    expect(roundSteps(plan.routes.loop!).length).toBeGreaterThanOrEqual(2);
  });

  it('S2: a $6,000,000 Spot loop into USDT costs the top-price cost plus the walked shortfall of each Sell', () => {
    const plan = scalePlan({ ...whale, usdt: 0, hyperliquid: 6_000_000 }, { 'USDT/CROSSEX': 6_000_000 }, BOOKED);
    const loop = plan.routes.loop!;
    const sold = roundSteps(loop).map((step) => step.arrives);
    const extra = sold.reduce((total, usdc) => total + usdc * TOP.bid - sellProceedsUsdt(usdc, DEPTH), 0);
    const topCost = sold.length * HYPERLIQUID_WITHDRAW_FEE_USD + convertCost(loop);
    expect(plan.recommended).toBe('loop');
    expect(extra).toBeGreaterThan(1_000);
    expect(Math.abs(loop.costUsd - topCost - extra)).toBeLessThanOrEqual(1);
    expect(walletIn(loop.after, 'USDC', 'HYPERLIQUID').equity).toBeLessThan(DUST);
  });
});

const LIVE_TICKER: Prices = { ask: 1.0009, bid: 1.0008 };
const LADDER = RUNGS.flatMap((rung) => [rung, rung - HAIR]);
type ConvertMove = { from: 'CROSSEX' | 'HYPERLIQUID'; to: 'CROSSEX' | 'HYPERLIQUID' | 'LIGHTER' };

function convertRoute(size: number, move: ConvertMove, prices: Partial<PlanInputs>): RoutePlan {
  const wallets = { usdt: move.from === 'CROSSEX' ? size : 0, hyperliquid: move.from === 'HYPERLIQUID' ? size : 0, lighter: 0 };
  const notional = { [move.to === 'CROSSEX' ? 'USDT/CROSSEX' : `USDC/${move.to}`]: size };
  return scalePlan({ ...wallets, positionIm: size / 10 }, notional, prices).routes.convert;
}

function onlyConvert(route: RoutePlan): PlannedStep {
  expect(route.steps).toHaveLength(1);
  expect(route.steps[0].kind).toBe('convert');
  return route.steps[0];
}

const HALF_CENT = 0.005 + 1e-6;

describe('planFor prices a Convert from the Gate spot price', () => {
  const toUsdc: ConvertMove = { from: 'CROSSEX', to: 'HYPERLIQUID' };
  const toUsdt: ConvertMove = { from: 'HYPERLIQUID', to: 'CROSSEX' };
  const halves: ConvertMove = { from: 'HYPERLIQUID', to: 'LIGHTER' };

  it.each(LADDER)('a Convert of %d USDT toward USDC at ask 1.0009 arrives at size x 0.998 / 1.0009 and costs the rest', (size) => {
    const route = convertRoute(size, toUsdc, LIVE_TICKER);
    const step = onlyConvert(route);
    const arrives = (step.move * KEPT) / 1.0009;
    expect(Math.abs(step.arrives - arrives)).toBeLessThan(0.01);
    expect(Math.abs(route.costUsd - (step.move - arrives))).toBeLessThanOrEqual(HALF_CENT);
    expect(walletIn(route.after, 'USDC', 'HYPERLIQUID').equity).toBe(step.arrives);
  });

  it.each(LADDER)('a Convert of %d USDC toward USDT at bid 1.0008 arrives at size x 0.998 x 1.0008 and costs only the Convert fee', (size) => {
    const route = convertRoute(size, toUsdt, LIVE_TICKER);
    const step = onlyConvert(route);
    expect(Math.abs(step.arrives - step.move * KEPT * 1.0008)).toBeLessThan(0.01);
    expect(Math.abs(route.costUsd - step.move * CONVERT_RATE)).toBeLessThanOrEqual(HALF_CENT);
    expect(walletIn(route.after, 'USDT', 'CROSSEX').equity).toBe(step.arrives);
  });

  it.each(LADDER)('a Convert of %d USDC toward USDT at bid 0.999 costs size minus size x 0.998 x 0.999', (size) => {
    const route = convertRoute(size, toUsdt, { ask: 1.0001, bid: 0.999 });
    const step = onlyConvert(route);
    const arrives = step.move * KEPT * 0.999;
    expect(Math.abs(step.arrives - arrives)).toBeLessThan(0.01);
    expect(Math.abs(route.costUsd - (step.move - arrives))).toBeLessThanOrEqual(HALF_CENT);
  });

  it.each(LADDER)('a Convert of %d USDC from Hyperliquid to Lighter at bid 1.0008 and ask 1.0009 prices both halves', (size) => {
    const route = convertRoute(size, halves, LIVE_TICKER);
    const step = onlyConvert(route);
    expect(step).toMatchObject({ from: 'HYPERLIQUID', to: 'LIGHTER' });
    expect(Math.abs(step.arrives - (step.move * KEPT * KEPT * 1.0008) / 1.0009)).toBeLessThan(0.01);
    expect(Math.abs(route.costUsd - (step.move - (step.move * KEPT * KEPT) / 1.0009))).toBeLessThanOrEqual(HALF_CENT);
    expect(walletIn(route.after, 'USDC', 'LIGHTER').equity).toBe(step.arrives);
  });

  it.each([toUsdc, toUsdt, halves].flatMap((move) => LADDER.map((size) => ({ ...move, size }))))(
    'a Convert of $size from $from to $to with no ticker, or a ticker at 1, keeps the old numbers',
    ({ from, to, size }) => {
      const atOne = convertRoute(size, { from, to }, { ask: 1, bid: 1 });
      for (const ticker of [{ ask: null, bid: null }, { ask: NaN, bid: NaN }, { ask: 0, bid: -5 }, { ask: Infinity, bid: Infinity }]) {
        expect(convertRoute(size, { from, to }, ticker)).toEqual(atOne);
      }
      const step = onlyConvert(atOne);
      const touchesUsdt = from === 'CROSSEX' || to === 'CROSSEX';
      const kept = touchesUsdt ? KEPT : KEPT ** 2;
      expect(step.arrives).toBe(floorCents(step.move * kept));
      expect(atOne.costUsd).toBe(nearestCents(touchesUsdt ? step.move * CONVERT_RATE : step.move - step.move * kept));
    },
  );

  it('at ask 1.0009 a Hyperliquid to Lighter move of 480.98 picks the 2.03 loop over the 2.35 Convert, where a ticker at 1 picked the 1.92 Convert', () => {
    const wallets = { usdt: 0, hyperliquid: 1060, lighter: 100, positionIm: 200 };
    const notional = { 'USDC/HYPERLIQUID': 5000, 'USDC/LIGHTER': 5000 };
    const atOne = scalePlan(wallets, notional, { ask: 1, bid: 1 });
    const live = scalePlan(wallets, notional, LIVE_TICKER);
    expect(atOne.routes.convert).toMatchObject({ costUsd: 1.92, steps: [expect.objectContaining({ move: 480.96 })] });
    expect(atOne.routes.loop!.costUsd).toBeGreaterThanOrEqual(atOne.routes.convert.costUsd);
    expect(atOne.recommended).toBe('convert');
    expect(live.routes.convert).toMatchObject({ costUsd: 2.35, steps: [expect.objectContaining({ move: 480.98 })] });
    expect(live.routes.loop).toMatchObject({ available: true, costUsd: 2.03 });
    expect(live.recommended).toBe('loop');
  });
});

function goalPlan(f: Wallets3, goal: Goal, notional: Record<string, number> = {}, inputs: Partial<PlanInputs> = {}) {
  const account = threeWallets(f);
  return planFor(bucketsFrom(account, BOTH_RATES, {}), account, { ...OPEN, ...inputs, notional }, goal);
}

const targetOf = (plan: EvenPlan, venue: string): number => {
  const row = plan.targets.find((t) => t.venue === venue);
  if (!row) throw new Error(`no target for ${venue}`);
  return row.equity;
};

const sumMoved = (route: RoutePlan): number => floorCents(route.steps.reduce((total, step) => total + step.move, 0));

describe('planFor even targets', () => {
  it('reports each pool at its share of total equity', () => {
    const plan = splitPlan({ usdt: 1000, hyperliquid: 200, lighter: 0, positionIm: 100 }, { 'USDT/CROSSEX': 1000, 'USDC/HYPERLIQUID': 1000 });
    expect(plan.goal).toEqual({ kind: 'even' });
    expect(targetOf(plan, 'CROSSEX')).toBe(600);
    expect(targetOf(plan, 'HYPERLIQUID')).toBe(600);
  });
});

describe('planFor repay', () => {
  it('with no legs, clears a USDT borrow from the USDC wallet', () => {
    const plan = goalPlan({ usdt: -300, hyperliquid: 1000, lighter: 0, positionIm: 0 }, REPAY_GOAL);
    expect(plan).toMatchObject({ goal: { kind: 'repay' }, balanced: false, noLegs: true, shortOfEven: 0 });
    expect(targetOf(plan, 'CROSSEX')).toBe(0);
    expect(targetOf(plan, 'HYPERLIQUID')).toBe(700);
    expect(plan.routes.convert.steps.map(moveOf)).toEqual(['HYPERLIQUID>CROSSEX']);
    const usdt = walletIn(plan.routes.convert.after, 'USDT', 'CROSSEX');
    expect(usdt.equity).toBeGreaterThanOrEqual(0);
    expect(usdt.equity).toBeLessThan(DUST);
    expect(plan.routes.convert.steps.at(-1)?.borrowLeft).toBe(0);
  });

  it('pays from the wallet with the largest positive equity first', () => {
    const plan = goalPlan({ usdt: -300, hyperliquid: 500, lighter: 2000, positionIm: 0 }, REPAY_GOAL);
    expect(plan.routes.convert.steps.map(moveOf)).toEqual(['LIGHTER>CROSSEX']);
    expect(targetOf(plan, 'LIGHTER')).toBe(1700);
    expect(targetOf(plan, 'HYPERLIQUID')).toBe(500);
    expect(targetOf(plan, 'CROSSEX')).toBe(0);
  });

  it('caps each payer at its cash, not its equity, and moves on to the next', () => {
    // Lighter has the most equity (100 cash + 900 unrealised) but only 100 can move.
    const plan = goalPlan({ usdt: -300, hyperliquid: 500, lighter: 100, lighterUpnl: 900, positionIm: 0 }, REPAY_GOAL);
    expect(targetOf(plan, 'LIGHTER')).toBe(900);
    expect(targetOf(plan, 'HYPERLIQUID')).toBe(300);
    expect(targetOf(plan, 'CROSSEX')).toBe(0);
    expect(plan.routes.convert.steps.map(moveOf).sort()).toEqual(['HYPERLIQUID>CROSSEX', 'LIGHTER>CROSSEX']);
    expect(plan.shortOfEven).toBe(0);
  });

  it('caps each payer at its equity too: cash covering an open loss stays put', () => {
    // Lighter holds 1000 cash but floats an 800 loss, so only 200 is its own.
    // Sending more would clear the USDT borrow by opening a Lighter one.
    const plan = goalPlan({ usdt: -300, hyperliquid: 0, lighter: 1000, lighterUpnl: -800, positionIm: 0 }, REPAY_GOAL);
    expect(targetOf(plan, 'LIGHTER')).toBe(0);
    expect(targetOf(plan, 'CROSSEX')).toBe(0);
    expect(sumMoved(plan.routes.convert)).toBe(200);
    expect(plan.shortOfEven).toBe(100);
    for (const route of [plan.routes.convert, plan.routes.loop!]) {
      const lighter = walletIn(route.after, 'USDC', 'LIGHTER');
      expect(lighter.equity).toBeGreaterThanOrEqual(0);
      expect(lighter.cash).toBeGreaterThanOrEqual(800);
    }
  });

  it('one payer feeding two borrows never goes past its equity in total', () => {
    const plan = goalPlan({ usdt: -300, hyperliquid: -100, lighter: 1000, lighterUpnl: -800, positionIm: 0 }, REPAY_GOAL);
    expect(targetOf(plan, 'LIGHTER')).toBe(0);
    expect(sumMoved(plan.routes.convert)).toBe(200);
    expect(plan.shortOfEven).toBe(200);
    expect(walletIn(plan.routes.convert.after, 'USDC', 'LIGHTER').equity).toBeGreaterThanOrEqual(0);
  });

  it('debt past all cash is the short', () => {
    const plan = goalPlan({ usdt: -1000, hyperliquid: 300, lighter: 0, positionIm: 0 }, REPAY_GOAL);
    expect(targetOf(plan, 'HYPERLIQUID')).toBe(0);
    expect(targetOf(plan, 'CROSSEX')).toBe(0);
    expect(plan.balanced).toBe(false);
    expect(sumMoved(plan.routes.convert)).toBe(300);
    expect(plan.shortOfEven).toBe(700);
  });

  it('with no negative wallet there is nothing to repay', () => {
    const plan = goalPlan({ usdt: 1000, hyperliquid: 500, lighter: 0, positionIm: 0 }, REPAY_GOAL);
    expect(plan).toMatchObject({ goal: { kind: 'repay' }, balanced: true, noLegs: true, moves: 0, shortOfEven: 0 });
  });

  it('clears a borrow under a dollar with one Convert', () => {
    // His book on 2026-09-20: every leg closed, 0.22 USDT left, 0.18 USDC owed.
    const plan = goalPlan({ usdt: 0.22, hyperliquid: -0.18, lighter: 0, positionIm: 0 }, REPAY_GOAL);
    expect(plan).toMatchObject({ goal: { kind: 'repay' }, balanced: false, noLegs: true, shortOfEven: 0 });
    expect(plan.routes.convert.available).toBe(true);
    expect(plan.routes.convert.steps.map((step) => `${step.kind}:${moveOf(step)}`)).toEqual(['convert:CROSSEX>HYPERLIQUID']);
    expect(sumMoved(plan.routes.convert)).toBeLessThanOrEqual(0.22);
    const usdc = walletIn(plan.routes.convert.after, 'USDC', 'HYPERLIQUID');
    expect(usdc.equity).toBeGreaterThanOrEqual(0);
    expect(usdc.equity).toBeLessThan(0.01);
    expect(plan.routes.convert.steps.at(-1)?.borrowLeft).toBe(0);
  });

  it('keeps the dollar floor for the other goals', () => {
    const wallets = { usdt: 0.22, hyperliquid: -0.18, lighter: 0, positionIm: 0 };
    expect(goalPlan(wallets, EVEN_GOAL)).toMatchObject({ balanced: true, moves: 0 });
    const custom = goalPlan(wallets, { kind: 'custom', from: 'CROSSEX', to: 'HYPERLIQUID', amount: 0.19 });
    expect(custom).toMatchObject({ balanced: true, moves: 0 });
  });

  it('with legs, repays the borrow and ignores position share', () => {
    const notional = { 'USDT/CROSSEX': 1000, 'USDC/HYPERLIQUID': 1000 };
    const even = goalPlan({ usdt: -300, hyperliquid: 2000, lighter: 0, positionIm: 100 }, EVEN_GOAL, notional);
    const repay = goalPlan({ usdt: -300, hyperliquid: 2000, lighter: 0, positionIm: 100 }, REPAY_GOAL, notional);
    expect(targetOf(even, 'CROSSEX')).toBe(850);
    expect(targetOf(repay, 'CROSSEX')).toBe(0);
    expect(targetOf(repay, 'HYPERLIQUID')).toBe(1700);
    expect(repay.noLegs).toBe(false);
    expect(repay.moves).toBeLessThan(even.moves);
  });
});

describe('planFor custom', () => {
  const custom = (from: Pool, to: Pool, amount: number): Goal => ({ kind: 'custom', from, to, amount });

  it('sends exactly the amount, as what leaves the sender', () => {
    const plan = goalPlan({ usdt: 1000, hyperliquid: 1000, lighter: 0, positionIm: 0 }, custom('HYPERLIQUID', 'CROSSEX', 250));
    expect(plan).toMatchObject({ goal: { kind: 'custom', from: 'HYPERLIQUID', to: 'CROSSEX', amount: 250 }, balanced: false, noLegs: true, shortOfEven: 0 });
    expect(targetOf(plan, 'CROSSEX')).toBe(1250);
    expect(targetOf(plan, 'HYPERLIQUID')).toBe(750);
    for (const route of routesOf(plan)) expect(sumMoved(route)).toBe(250);
    const [step] = plan.routes.convert.steps;
    expect(step.move).toBe(250);
    expect(step.arrives).toBeLessThan(250);
    expect(walletIn(plan.routes.convert.after, 'USDC', 'HYPERLIQUID').equity).toBe(750);
  });

  it('can open an empty wallet', () => {
    const plan = goalPlan({ usdt: 1000, hyperliquid: 0, lighter: 0, positionIm: 0 }, custom('CROSSEX', 'LIGHTER', 200));
    expect(plan.balanced).toBe(false);
    expect(plan.routes.convert.steps.map(moveOf)).toEqual(['CROSSEX>LIGHTER']);
    expect(targetOf(plan, 'LIGHTER')).toBe(200);
    expect(walletIn(plan.routes.convert.after, 'USDC', 'LIGHTER').equity).toBeGreaterThan(0);
  });

  it('more than the wallet holds moves the cash and reports the rest as short', () => {
    const plan = goalPlan({ usdt: 1000, hyperliquid: 100, lighter: 0, positionIm: 0 }, custom('HYPERLIQUID', 'CROSSEX', 500));
    expect(plan.balanced).toBe(false);
    expect(sumMoved(plan.routes.convert)).toBe(100);
    expect(plan.shortOfEven).toBe(400);
  });

  it('the same wallet on both ends, or an amount under 1, is nothing to move', () => {
    const same = goalPlan({ usdt: 1000, hyperliquid: 1000, lighter: 0, positionIm: 0 }, custom('CROSSEX', 'CROSSEX', 250));
    const dust = goalPlan({ usdt: 1000, hyperliquid: 1000, lighter: 0, positionIm: 0 }, custom('HYPERLIQUID', 'CROSSEX', 0.5));
    expect(same).toMatchObject({ balanced: true, moves: 0, shortOfEven: 0 });
    expect(dust).toMatchObject({ balanced: true, moves: 0, shortOfEven: 0 });
  });

  it('routes it like any other move: the loop is offered when it beats Convert', () => {
    const plan = goalPlan({ usdt: 0, hyperliquid: 1060, lighter: 100, positionIm: 0 }, custom('HYPERLIQUID', 'LIGHTER', 480.98), {}, LIVE_TICKER);
    expect(routesOf(plan).length).toBeGreaterThan(1);
    expect(plan.recommended).not.toBeNull();
  });
});
