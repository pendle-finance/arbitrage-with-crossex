import { describe, it, expect } from 'vitest';
import { roundToStep } from '../../src/core/numbers';
import {
  bucketsFrom,
  fit,
  planFor,
  USDC_WALLET,
  USDT_WALLET,
  TO_USDC_WAIT_SECONDS,
  TO_USDT_WAIT_SECONDS,
  type AccountLike,
  type AssetLike,
  type CoinRuleLike,
  type PlanInputs,
  type RateLike,
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
};

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
    for (const route of [plan.routes.loop, plan.routes.convert]) {
      const usdt = walletIn(route.after, 'USDT', 'CROSSEX').equity;
      const usdc = walletIn(route.after, 'USDC', 'HYPERLIQUID').equity;
      expect(Math.abs(usdt - usdc)).toBeLessThanOrEqual(0.05);
    }
  });

  it('A Gate bucket ends empty', () => {
    expect(walletIn(plan.routes.loop.after, 'USDC', 'GATE').cash).toBe(0);
    expect(walletIn(plan.routes.convert.after, 'USDC', 'GATE').cash).toBe(0);
  });

  it('A round 1 buys nothing', () => {
    expect(plan.routes.loop.steps[0].buy).toBe(0);
  });

  it('A round 1 is sized at 112 percent', () => {
    expect(plan.routes.loop.steps[0].move).toBe(24.51);
  });

  it('A mix is null', () => {
    expect(plan.routes.mix).toBeNull();
  });

  it('A recommends loop', () => {
    expect(plan.recommended).toBe('loop');
  });

  it('A loop frees 29.41', () => {
    expect(plan.routes.loop.marginFreedUsd).toBeCloseTo(29.41, 2);
  });

  it('A loop takes 650 s', () => {
    expect(plan.routes.loop.seconds).toBe(650);
  });

  it('A loop runs five rounds whose sizes grow as the borrow is repaid', () => {
    const moves = plan.routes.loop.steps.map((step) => step.move);
    expect(moves.slice(0, 4)).toEqual([24.51, 29.93, 36.58, 44.71]);
    expect(plan.routes.loop.rounds).toBe(5);
    expect(plan.routes.loop.costUsd).toBeCloseTo(0.26, 2);
    expect(plan.routes.loop.steps.every((step) => step.seconds === TO_USDC_WAIT_SECONDS)).toBe(true);
  });

  it('A round 4 buys what the Gate bucket no longer covers', () => {
    const round4 = plan.routes.loop.steps[3];
    expect(round4).toMatchObject({ round: 4, kind: 'round', buy: 23.77, move: 44.71, arrives: 44.66 });
  });

  it('A convert sends one step and prices the Gate bucket sale in its cost', () => {
    expect(plan.routes.convert.steps).toHaveLength(1);
    expect(plan.routes.convert.steps[0]).toMatchObject({ round: null, kind: 'convert', buy: 0, move: 175.94, seconds: 0 });
    expect(plan.routes.convert.costUsd).toBeCloseTo(0.36, 2);
  });
});

describe('planFor Account A, round 3 in Gate spot', () => {
  const plan = planOf(ACCOUNT_A_ROUND_3);

  it('no free margin blocks the loop', () => {
    expect(plan.routes.loop.available).toBe(false);
    expect(plan.routes.loop.reason).toBe('Free margin is too low for an 11 USDC round.');
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
    expect(walletIn(plan.routes.loop.after, 'USDC', 'GATE').cash).toBe(0.29);
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

  it('C mix is null when rounds never help', () => {
    expect(plan.direction).toBe('toUsdt');
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.loop).toMatchObject({ rounds: 1, costUsd: 1, seconds: TO_USDT_WAIT_SECONDS });
    expect(plan.routes.convert.costUsd).toBeCloseTo(0.04, 2);
  });
});

describe('planFor Example D', () => {
  const plan = planOf(EXAMPLE_D);

  it('D spot loop runs 11 rounds', () => {
    expect(plan.routes.loop.rounds).toBe(11);
  });

  it('D spot loop has no Convert', () => {
    expect(plan.routes.loop.steps.some((step) => step.kind === 'convert')).toBe(false);
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
    expect(steps[6].move).toBeCloseTo(7521.59, 2);
  });

  it('D saves nothing under the interest line', () => {
    expect(plan.routes.mix!.savesPerDayUsd).toBe(0);
  });

  it('D mix takes 780 s', () => {
    expect(plan.routes.mix!.seconds).toBe(780);
  });

  it('D loop costs 1.63', () => {
    expect(plan.routes.loop.costUsd).toBeCloseTo(1.63, 2);
  });

  it('D skips the cheaper loop because it takes over 15 min', () => {
    expect(plan.routes.loop.costUsd).toBeLessThan(plan.routes.mix!.costUsd);
    expect(plan.routes.loop.seconds).toBeGreaterThan(900);
  });

  it('D mix at the round cap has no one more round cost', () => {
    expect(plan.roundCap).toBe(6);
    expect(plan.routes.mix!.oneMoreRoundCostUsd).toBeNull();
    expect(plan.routes.mix!.costUsd).toBeCloseTo(15.68, 2);
    expect(plan.routes.mix!.marginFreedUsd).toBeCloseTo(1922.48, 2);
  });
});

describe('planFor Example E', () => {
  const plan = planOf(EXAMPLE_E);

  it('E mix stops at 1 round', () => {
    expect(plan.routes.mix!.rounds).toBe(1);
  });

  it('E one more round cost', () => {
    expect(plan.routes.mix!.oneMoreRoundCostUsd).toBe(plan.routes.loop.costUsd);
    expect(plan.routes.loop.costUsd).toBeCloseTo(2.12, 2);
  });

  it('E rounds move out of the Hyperliquid wallet less the 1.00 fee', () => {
    expect(plan.direction).toBe('toUsdt');
    expect(plan.routes.mix!.steps[0]).toMatchObject({ kind: 'round', buy: 0, move: 745.44, arrives: 744.44, seconds: 400 });
    expect(plan.routes.mix!.costUsd).toBeCloseTo(2.04, 2);
    expect(plan.routes.mix!.marginFreedUsd).toBeCloseTo(122.47, 2);
    expect(plan.recommended).toBe('mix');
  });
});

describe('planFor toward USDT with USDC in the Gate bucket', () => {
  const plan = planOf({ usdt: 100, gate: 50, usdc: 250, positionIm: 0 });

  it('toward USDT sells the Gate bucket and ends even', () => {
    expect(plan.direction).toBe('toUsdt');
    for (const route of [plan.routes.loop, plan.routes.convert]) {
      const usdt = walletIn(route.after, 'USDT', 'CROSSEX').equity;
      const usdc = walletIn(route.after, 'USDC', 'HYPERLIQUID').equity;
      expect(walletIn(route.after, 'USDC', 'GATE').cash).toBe(0);
      expect(Math.abs(usdt - 200)).toBeLessThanOrEqual(1);
      expect(Math.abs(usdc - 200)).toBeLessThanOrEqual(1);
      expect(Math.abs(usdt - usdc)).toBeLessThanOrEqual(0.05);
    }
  });

  it('toward USDT prices the Gate bucket sale in the cost', () => {
    expect(plan.routes.convert.steps).toEqual([expect.objectContaining({ kind: 'convert', move: 50.05 })]);
    expect(plan.routes.convert.costUsd).toBeCloseTo(0.11, 2);
    expect(walletIn(plan.routes.convert.after, 'USDT', 'CROSSEX').equity).toBe(199.93);
    expect(plan.routes.loop.steps).toEqual([expect.objectContaining({ kind: 'round', move: 50.5, arrives: 49.5 })]);
    expect(walletIn(plan.routes.loop.after, 'USDT', 'CROSSEX').equity).toBe(199.49);
  });

  it('toward USDT keeps Gate bucket dust under 1', () => {
    const dust = planOf({ usdt: 100, gate: 0.5, usdc: 250, positionIm: 0 });
    expect(walletIn(dust.routes.loop.after, 'USDC', 'GATE').cash).toBe(0.5);
    expect(walletIn(dust.routes.convert.after, 'USDC', 'GATE').cash).toBe(0.5);
  });
});

describe('planFor sending wallet with no cash', () => {
  const plan = planOf({ usdt: 100, gate: 0, usdc: -5, usdcUpnl: 500, positionIm: 0 });

  it('no cash to send is balanced and keeps short of even', () => {
    expect(plan).toMatchObject({ direction: 'toUsdt', balanced: true, moves: 0, shortOfEven: 197.5, recommended: null });
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
    expect(partial.steps).toEqual([expect.objectContaining({ move: 1000, arrives: 998 })]);
    expect(partial.savesPerDayUsd).toBe(Number(cents((3000 - 2002) * 0.00001 * 24)));
  });
});

describe('planFor Thin margin', () => {
  const plan = planOf(THIN_MARGIN);

  it('thin margin no round under 11', () => {
    const rounds = plan.routes.loop.steps.filter((step) => step.kind === 'round');
    expect(rounds.map((step) => step.move)).toEqual([12, 11.95]);
    expect(rounds.every((step) => step.move >= 11)).toBe(true);
  });

  it('thin margin converts the rest', () => {
    const last = plan.routes.loop.steps[plan.routes.loop.steps.length - 1];
    expect(last.kind).toBe('convert');
    expect(last.move).toBeCloseTo(2.09, 2);
  });
});

describe('planFor loop sizing', () => {
  it('loop shrinks a round so the last one is 11', () => {
    const plan = planOf({ usdt: 1060, gate: 0, usdc: 1000, positionIm: 1821.43 });
    expect(plan.routes.loop.steps.map((step) => [step.kind, step.move])).toEqual([
      ['round', 19.04],
      ['round', 11],
    ]);
  });

  it('11 USDC out of Hyperliquid is allowed', () => {
    const plan = planOf({ usdt: 0, gate: 0, usdc: 11, usdcUpnl: 100, positionIm: 0 });
    expect(plan.direction).toBe('toUsdt');
    expect(plan.routes.loop.steps[0]).toMatchObject({ kind: 'round', move: 11, arrives: 10 });
    expect(plan.routes.loop.available).toBe(true);
  });

  it('adds the spot taker fee to the loop cost', () => {
    const free = planOf(ACCOUNT_B).routes.loop.costUsd;
    const taxed = planOf(ACCOUNT_B, { ...OPEN, spotTakerRate: 0.001 }).routes.loop.costUsd;
    expect(taxed).toBeGreaterThan(free + 0.4);
  });
});

describe('planFor balanced', () => {
  it('under 1 is balanced', () => {
    const plan = planOf({ usdt: 500, gate: 0, usdc: 499.5, positionIm: 0 });
    expect(plan.balanced).toBe(true);
  });

  it('a balanced plan has no direction and no route to run', () => {
    const plan = planOf({ usdt: 500, gate: 0, usdc: 499.5, positionIm: 0 });
    expect(plan).toMatchObject({ direction: null, moves: 0, shortOfEven: 0, recommended: null });
    expect(plan.routes.mix).toBeNull();
    expect(plan.routes.loop).toMatchObject({ available: false, reason: null, steps: [] });
    expect(plan.routes.convert).toMatchObject({ available: false, reason: null, steps: [] });
  });
});

describe('planFor blocked routes', () => {
  const paused: PlanInputs = { ...OPEN, coins: [{ ...USDC_RULE, isDisabled: 1 }] };

  it('paused transfers block the loop', () => {
    expect(planOf(ACCOUNT_A, paused).routes.loop.reason).toBe('Gate paused USDC transfers.');
  });

  it('paused transfers recommend convert', () => {
    expect(planOf(ACCOUNT_A, paused).recommended).toBe('convert');
  });

  it('string is_disabled blocks the loop', () => {
    const inputs: PlanInputs = { ...OPEN, coins: [{ coin: 'USDC', minTransAmount: '11', estFee: '1', isDisabled: '1' }] };
    expect(planOf(ACCOUNT_A, inputs).routes.loop.reason).toBe('Gate paused USDC transfers.');
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
    expect(planOf(ACCOUNT_A, { ...OPEN, ask: null }).routes.loop.reason).toBe('The spot market for USDC is closed.');
    expect(planOf(EXAMPLE_E, { ...OPEN, bid: 0 }).routes.loop.reason).toBe('The spot market for USDC is closed.');
  });

  it('paused transfers are named before a closed spot market', () => {
    const plan = planOf(ACCOUNT_A, { ...paused, spotRule: null });
    expect(plan.routes.loop.reason).toBe('Gate paused USDC transfers.');
  });

  it('move under 11 blocks the loop with its own reason', () => {
    const plan = planOf({ usdt: 510, gate: 0, usdc: 500, positionIm: 0 });
    expect(fit({ marginBalance: 1010, initialMargin: 0 }, 510)).toBeGreaterThan(11);
    expect(plan.routes.loop).toMatchObject({ available: false, reason: 'The move is under the 11 USDC minimum.' });
    expect(plan.routes.mix).toBeNull();
    expect(plan.recommended).toBe('convert');
  });

  it('no USDC coin rule leaves the loop open', () => {
    expect(planOf(ACCOUNT_A, { ...OPEN, coins: [] }).routes.loop).toMatchObject({ available: true, reason: null });
  });

  it('cash under 11 blocks the loop with the cash reason', () => {
    const plan = planOf({ usdt: 100, gate: 0, usdc: 8, usdcUpnl: 500, positionIm: 10 });
    expect(plan.routes.loop).toMatchObject({ available: false, reason: 'Not enough cash for an 11 USDC round.' });
    expect(plan.routes.convert).toMatchObject({ available: true, reason: null });
    expect(plan.recommended).toBe('convert');
  });
});

describe('planFor loose Gate numbers', () => {
  it.each(['', '  ', 0, '0', 'n/a', -3])('a USDC minimum of %j falls back to 11 and never hangs the plan', (min) => {
    const plan = planOf(ACCOUNT_A_ROUND_3, { ...OPEN, coins: [{ ...USDC_RULE, minTransAmount: min }] });
    expect(plan.routes.loop.reason).toBe('Free margin is too low for an 11 USDC round.');
    expect(plan.routes.loop.steps.every((step) => step.move > 0)).toBe(true);
    const rounds = planOf(ACCOUNT_A, { ...OPEN, coins: [{ ...USDC_RULE, minTransAmount: min }] }).routes.loop.steps;
    expect(rounds.map((step) => step.move)).toEqual([24.51, 29.93, 36.58, 44.71, 40.16]);
  });
});
