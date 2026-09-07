import { describe, it, expect } from 'vitest';
import {
  bucketsFrom,
  planFor,
  DEFICIT,
  SURPLUS,
  SPOT_SYMBOL,
  LOOP_WAIT_SECONDS,
  PULL_FEE_USD,
  PULL_WAIT_SECONDS,
  type AccountLike,
  type AssetLike,
  type PlanInputs,
  type PlanRequest,
  type RateLike,
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

const USDC_RATE: RateLike[] = [{ coin: DEFICIT.coin, exchangeType: DEFICIT.venue, hourInterestRate: '0.00001' }];

const OPEN: PlanInputs = {
  usdcTransfer: { isDisabled: 0, minTransAmount: 11 },
  spotRule: { state: 'live' },
  spotTakerRate: 0,
  ask: 1.0001,
  bid: 0.9999,
};

const PULL: PlanRequest = { direction: 'pull' };

interface Scenario {
  usdcEquity: number;
  usdcBorrow?: number;
  usdcIm?: number;
  usdcCash?: number;
  usdcAvailable?: number;
  usdtCash: number;
  margin: number;
}

function accountFor(s: Scenario): AccountLike {
  return {
    availableMargin: String(s.margin),
    assets: [
      asset(DEFICIT.coin, DEFICIT.venue, {
        balance: s.usdcCash ?? 0,
        availableBalance: s.usdcAvailable ?? s.usdcCash ?? 0,
        equity: s.usdcEquity,
        liability: s.usdcBorrow ?? Math.max(0, -s.usdcEquity),
        borrowingInitialMargin: s.usdcIm ?? 0,
      }),
      asset(SURPLUS.coin, SURPLUS.venue, { balance: s.usdtCash, equity: s.usdtCash }),
    ],
  };
}

function plan(s: Scenario, inputs: PlanInputs = OPEN, request?: PlanRequest) {
  const account = accountFor(s);
  return planFor(bucketsFrom(account, USDC_RATE, []), account, inputs, request);
}

describe('bucketsFrom interest', () => {
  it('maps one row per asset: cash from balance, borrow from liability', () => {
    const account: AccountLike = {
      availableMargin: '100',
      assets: [
        asset('USDC', 'HYPERLIQUID', { balance: -50, upnl: 10, equity: -40, liability: 50 }),
        asset('USDT', 'CROSSEX', { balance: 200, upnl: 0, equity: 200 }),
      ],
    };
    const buckets = bucketsFrom(account, USDC_RATE, []);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ coin: 'USDC', venue: 'HYPERLIQUID', cash: -50, upnl: 10, equity: -40, borrow: 50 });
    expect(buckets[1]).toMatchObject({ coin: 'USDT', venue: 'CROSSEX', cash: 200, upnl: 0, equity: 200, borrow: 0 });
  });

  it('charges interest per day when equity is below -10000', () => {
    const account = accountFor({ usdcEquity: -10001, usdtCash: 0, margin: 0 });
    const [usdc] = bucketsFrom(account, USDC_RATE, []);
    expect(usdc.interestPerDayUsd).toBeCloseTo(10001 * 0.00001 * 24, 9);
  });

  it('charges no interest at exactly -10000', () => {
    const account = accountFor({ usdcEquity: -10000, usdtCash: 0, margin: 0 });
    const [usdc] = bucketsFrom(account, USDC_RATE, []);
    expect(usdc.interestPerDayUsd).toBe(0);
  });

  it('uses rate 0 when no rate row matches the coin and venue', () => {
    const account = accountFor({ usdcEquity: -20000, usdtCash: 0, margin: 0 });
    const other: RateLike[] = [{ coin: 'USDC', exchangeType: 'GATE', hourInterestRate: '0.5' }];
    const [usdc] = bucketsFrom(account, other, []);
    expect(usdc.interestPerDayUsd).toBe(0);
  });

  it('sums interest paid over rows with the same coin and venue', () => {
    const account = accountFor({ usdcEquity: -500, usdtCash: 0, margin: 0 });
    const rows = [
      { liabilityCoin: 'USDC', exchangeType: 'HYPERLIQUID', interest: '1.5' },
      { liabilityCoin: 'USDC', exchangeType: 'HYPERLIQUID', interest: '2.25' },
      { liabilityCoin: 'USDC', exchangeType: 'GATE', interest: '9' },
      { liabilityCoin: 'USDT', exchangeType: 'CROSSEX', interest: '4' },
    ];
    const [usdc, usdt] = bucketsFrom(account, USDC_RATE, rows);
    expect(usdc.interestPaid30dUsd).toBeCloseTo(3.75, 9);
    expect(usdt.interestPaid30dUsd).toBe(4);
  });

  it('reads interest paid as 0 with no rows', () => {
    const account = accountFor({ usdcEquity: -500, usdtCash: 0, margin: 0 });
    const [usdc] = bucketsFrom(account, USDC_RATE, []);
    expect(usdc.interestPaid30dUsd).toBe(0);
  });
});

describe('bucketsFrom held margin', () => {
  it('reads imHeldUsd and mmHeldUsd from the asset borrowing margins', () => {
    const account: AccountLike = {
      availableMargin: '100',
      assets: [
        asset('USDC', 'HYPERLIQUID', {
          equity: -300,
          liability: 300,
          borrowingInitialMargin: 60,
          borrowingMaintenanceMargin: 30,
        }),
        asset('USDT', 'CROSSEX', { balance: 1200, equity: 1200 }),
      ],
    };
    const [usdc, usdt] = bucketsFrom(account, USDC_RATE, []);
    expect(usdc).toMatchObject({ borrow: 300, imHeldUsd: 60, mmHeldUsd: 30 });
    expect(usdt).toMatchObject({ imHeldUsd: 0, mmHeldUsd: 0 });
  });

  it('reads held margin as 0 when the asset margin is not a number', () => {
    const account: AccountLike = {
      availableMargin: '100',
      assets: [{ ...asset('USDC', 'HYPERLIQUID'), borrowingInitialMargin: '', borrowingMaintenanceMargin: 'n/a' }],
    };
    const [usdc] = bucketsFrom(account, USDC_RATE, []);
    expect(usdc).toMatchObject({ imHeldUsd: 0, mmHeldUsd: 0 });
  });
});

describe('planFor amount', () => {
  it('equals the deficit when the deficit is the smallest', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 1000, margin: 2000 });
    expect(p.amount).toBe(500);
  });

  it('equals the USDT cash when cash is the smallest', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 300.456, margin: 2000 });
    expect(p.amount).toBe(300.45);
  });

  it('equals the available margin when margin is the smallest', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 1000, margin: 120 });
    expect(p.amount).toBe(120);
  });

  it('floors the amount to 0.01', () => {
    const p = plan({ usdcEquity: -12.999, usdtCash: 1000, margin: 2000 });
    expect(p.amount).toBe(12.99);
  });

  it('is 0 when USDC on Hyperliquid has no deficit', () => {
    const p = plan({ usdcEquity: 50, usdtCash: 1000, margin: 2000 });
    expect(p.amount).toBe(0);
  });

  it('is 0 when the USDC bucket is absent', () => {
    const account: AccountLike = { availableMargin: '2000', assets: [asset('USDT', 'CROSSEX', { balance: 1000 })] };
    const p = planFor(bucketsFrom(account, USDC_RATE, []), account, OPEN);
    expect(p.amount).toBe(0);
  });

  it('never goes below 0 when the USDT cash is negative', () => {
    const p = plan({ usdcEquity: -500, usdtCash: -3.456, margin: 2000 });
    expect(p.amount).toBe(0);
  });

  it('carries savesPerDayUsd and marginFreedUsd scaled by amount over borrow', () => {
    const p = plan({ usdcEquity: -20000, usdcBorrow: 20000, usdcIm: 4000, usdtCash: 5000, margin: 50000 });
    expect(p.amount).toBe(5000);
    expect(p.savesPerDayUsd).toBeCloseTo((20000 * 0.00001 * 24 * 5000) / 20000, 9);
    expect(p.marginFreedUsd).toBeCloseTo((5000 * 4000) / 20000, 9);
  });

  it('reads savesPerDayUsd and marginFreedUsd as 0 when the borrow is 0', () => {
    const p = plan({ usdcEquity: -500, usdcBorrow: 0, usdcIm: 0, usdtCash: 1000, margin: 2000 });
    expect(p.savesPerDayUsd).toBe(0);
    expect(p.marginFreedUsd).toBe(0);
  });
});

describe('planFor requested amount', () => {
  const s: Scenario = { usdcEquity: -500, usdtCash: 1000, margin: 2000 };

  it('reads as payDown for the full deficit when no request is given', () => {
    const p = plan(s);
    expect(p.direction).toBe('payDown');
    expect(p.amount).toBe(500);
  });

  it('equals the requested amount when it is the smallest', () => {
    const p = plan(s, OPEN, { requested: 120 });
    expect(p.amount).toBe(120);
  });

  it('floors the requested amount to 0.01', () => {
    expect(plan(s, OPEN, { requested: 120.005 }).amount).toBe(120);
  });

  it('caps a requested amount above the deficit at the deficit', () => {
    expect(plan(s, OPEN, { requested: 5000 }).amount).toBe(500);
  });

  it('caps a requested amount at the cash and keeps the cash shortfall', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 300, margin: 2000 }, OPEN, { requested: 100 });
    expect(p.amount).toBe(100);
    expect(p.shortfall).toEqual({ reason: 'cash', remaining: 400 });
  });

  it('carries the loop price, receives, and borrowAfterUsd', () => {
    const p = plan(s, OPEN, { requested: 120 });
    expect(p.route).toBe('loop');
    expect(p.price).toBe(1.0001);
    expect(p.receives).toBe(119.93);
    expect(p.borrowAfterUsd).toBeCloseTo(500 - 119.93, 9);
  });

  it('takes the spot taker fee out of receives on the loop', () => {
    const p = plan(s, { ...OPEN, spotTakerRate: 0.001 }, { requested: 120 });
    expect(p.route).toBe('loop');
    expect(p.receives).toBe(119.81);
  });

  it('carries the convert price, receives, and borrowAfterUsd', () => {
    const p = plan({ usdcEquity: -20, usdtCash: 1000, margin: 2000 });
    expect(p.route).toBe('convert');
    expect(p.price).toBeCloseTo(0.998, 9);
    expect(p.receives).toBe(19.96);
    expect(p.borrowAfterUsd).toBeCloseTo(0.04, 9);
  });

  it('reads price null, receives 0, and the full deficit as borrowAfterUsd when no route is available', () => {
    const p = plan(s, { ...OPEN, usdcTransfer: null }, { requested: 0 });
    expect(p.route).toBeNull();
    expect(p.price).toBeNull();
    expect(p.receives).toBe(0);
    expect(p.borrowAfterUsd).toBe(500);
  });
});

describe('planFor shortfall', () => {
  it('is null when the deficit is the smallest', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 1000, margin: 2000 });
    expect(p.shortfall).toBeNull();
  });

  it('is null when the deficit is 0', () => {
    const p = plan({ usdcEquity: 50, usdtCash: 0, margin: 0 });
    expect(p.shortfall).toBeNull();
  });

  it('names cash with the remaining deficit when cash is the smallest', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 300, margin: 2000 });
    expect(p.shortfall).toEqual({ reason: 'cash', remaining: 200 });
  });

  it('names margin with the remaining deficit when margin is the smallest', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 1000, margin: 120 });
    expect(p.shortfall).toEqual({ reason: 'margin', remaining: 380 });
  });

  it('names cash when cash and margin tie as the smallest', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 300, margin: 300 });
    expect(p.shortfall).toEqual({ reason: 'cash', remaining: 200 });
  });

  it('floors remaining to 0.01', () => {
    const p = plan({ usdcEquity: -500.129, usdtCash: 300, margin: 2000 });
    expect(p.amount).toBe(300);
    expect(p.shortfall).toEqual({ reason: 'cash', remaining: 200.12 });
  });
});

describe('planFor route', () => {
  it('quotes loop at 150 s and convert at 0 s with the formula costs', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 1000, margin: 2000 });
    expect(p.routes.loop.waitSeconds).toBe(LOOP_WAIT_SECONDS);
    expect(p.routes.loop.waitSeconds).toBe(150);
    expect(p.routes.convert.waitSeconds).toBe(0);
    expect(p.routes.loop.costUsd).toBeCloseTo(500 * 0.0001 + 0.05, 9);
    expect(p.routes.convert.costUsd).toBeCloseTo(500 * 0.002, 9);
  });

  it('adds the spot taker fee to the loop cost', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 1000, margin: 2000 }, { ...OPEN, spotTakerRate: 0.001 });
    expect(p.routes.loop.costUsd).toBeCloseTo(500 * 0.0001 + 500 * 0.001 + 0.05, 9);
  });

  it('picks loop when both are available and loop is cheaper', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 1000, margin: 2000 });
    expect(p.routes.loop.available).toBe(true);
    expect(p.routes.convert.available).toBe(true);
    expect(p.route).toBe('loop');
  });

  it('picks convert when both are available and convert is cheaper', () => {
    const p = plan({ usdcEquity: -20, usdtCash: 1000, margin: 2000 });
    expect(p.routes.loop.available).toBe(true);
    expect(p.routes.convert.available).toBe(true);
    expect(p.routes.convert.costUsd).toBeLessThan(p.routes.loop.costUsd);
    expect(p.route).toBe('convert');
  });

  it('picks convert when the costs are equal', () => {
    const p = plan({ usdcEquity: -25, usdtCash: 1000, margin: 2000 }, { ...OPEN, ask: 1 });
    expect(p.routes.loop.costUsd).toBe(p.routes.convert.costUsd);
    expect(p.route).toBe('convert');
  });

  it('picks the one available route', () => {
    const p = plan(
      { usdcEquity: -500, usdtCash: 1000, margin: 2000 },
      { ...OPEN, usdcTransfer: { isDisabled: 1, minTransAmount: 11 } },
    );
    expect(p.routes.loop.available).toBe(false);
    expect(p.routes.convert.available).toBe(true);
    expect(p.route).toBe('convert');
  });

  it('is null when amount is 0 and both routes say nothing to move', () => {
    const p = plan({ usdcEquity: 50, usdtCash: 1000, margin: 2000 });
    expect(p.route).toBeNull();
    expect(p.routes.loop).toMatchObject({ available: false, reason: 'nothing to move' });
    expect(p.routes.convert).toMatchObject({ available: false, reason: 'nothing to move' });
  });

  it('reads reason null on an available route', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 1000, margin: 2000 });
    expect(p.routes.loop.reason).toBeNull();
    expect(p.routes.convert.reason).toBeNull();
  });
});

describe('planFor loop unavailable', () => {
  const s: Scenario = { usdcEquity: -500, usdtCash: 1000, margin: 2000 };

  it('when the USDC transfer isDisabled is 1', () => {
    const p = plan(s, { ...OPEN, usdcTransfer: { isDisabled: 1, minTransAmount: 11 } });
    expect(p.routes.loop.available).toBe(false);
    expect(p.routes.loop.reason).toBe('Gate has paused USDC transfers on CrossEx. Try again later.');
  });

  it('when the USDC transfer row is missing', () => {
    const p = plan(s, { ...OPEN, usdcTransfer: null });
    expect(p.routes.loop.available).toBe(false);
    expect(p.routes.loop.reason).toBe('Gate has paused USDC transfers on CrossEx. Try again later.');
  });

  it('when the spot rule is not live', () => {
    const p = plan(s, { ...OPEN, spotRule: { state: 'suspended' } });
    expect(p.routes.loop.available).toBe(false);
    expect(p.routes.loop.reason).toBe('The USDC/USDT spot market on Gate is not trading right now.');
    expect(p.routes.loop.reason).toBe('The USDC/USDT spot market on Gate is not trading right now.');
  });

  it('when the spot rule is missing', () => {
    const p = plan(s, { ...OPEN, spotRule: null });
    expect(p.routes.loop.available).toBe(false);
    expect(p.routes.loop.reason).toBe('The USDC/USDT spot market on Gate is not trading right now.');
  });

  it('when there is no spot ask', () => {
    expect(plan(s, { ...OPEN, ask: null }).routes.loop.reason).toBe('No price for USDC/USDT on Gate spot right now.');
    expect(plan(s, { ...OPEN, ask: 0 }).routes.loop.reason).toBe('No price for USDC/USDT on Gate spot right now.');
    expect(plan(s, { ...OPEN, ask: 0 }).routes.loop.available).toBe(false);
  });

  it('when the bought USDC is below the transfer minimum', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 11, margin: 2000 });
    expect(p.amount).toBe(11);
    expect(p.routes.loop.available).toBe(false);
    expect(p.routes.loop.reason).toBe('Too small for the spot loop. Gate needs at least 11 USDC per transfer.');
  });

  it('is available when 12 USDT buys 11.99 USDC', () => {
    const p = plan({ usdcEquity: -500, usdtCash: 12, margin: 2000 });
    expect(p.amount).toBe(12);
    expect(p.routes.loop.available).toBe(true);
    expect(p.routes.loop.reason).toBeNull();
  });

  it('reports the first cause only', () => {
    const nothing = plan({ usdcEquity: 50, usdtCash: 1000, margin: 2000 }, { ...OPEN, usdcTransfer: null, spotRule: null });
    expect(nothing.routes.loop.reason).toBe('nothing to move');
    const disabled = plan(s, { ...OPEN, usdcTransfer: { isDisabled: 1, minTransAmount: 11 }, spotRule: null, ask: null });
    expect(disabled.routes.loop.reason).toBe('Gate has paused USDC transfers on CrossEx. Try again later.');
    const notLive = plan(s, { ...OPEN, spotRule: { state: 'paused' }, ask: null });
    expect(notLive.routes.loop.reason).toBe('The USDC/USDT spot market on Gate is not trading right now.');
  });

  it('leaves convert available when only loop is unavailable', () => {
    const p = plan(s, { ...OPEN, ask: null });
    expect(p.routes.convert.available).toBe(true);
    expect(p.route).toBe('convert');
  });
});

describe('planFor pull', () => {
  const s: Scenario = { usdcEquity: 50, usdcCash: 50, usdtCash: 1000, margin: 2000 };

  it('reads as pull with the bucket equity as the amount', () => {
    const p = plan(s, OPEN, PULL);
    expect(p.direction).toBe('pull');
    expect(p.amount).toBe(50);
  });

  it('equals the requested amount when it is the smallest', () => {
    expect(plan(s, OPEN, { ...PULL, requested: 20 }).amount).toBe(20);
  });

  it('equals the available balance when it is the smallest', () => {
    expect(plan({ ...s, usdcAvailable: 30 }, OPEN, PULL).amount).toBe(30);
  });

  it('equals the equity when it is the smallest', () => {
    expect(plan({ ...s, usdcAvailable: 80 }, OPEN, PULL).amount).toBe(50);
  });

  it('floors the amount to 0.01', () => {
    expect(plan({ ...s, usdcEquity: 50.129, usdcAvailable: 100 }, OPEN, PULL).amount).toBe(50.12);
  });

  it('is 0 when the equity is 0 or below, with both routes unavailable', () => {
    for (const usdcEquity of [0, -300]) {
      const p = plan({ ...s, usdcEquity, usdcAvailable: 100 }, OPEN, PULL);
      expect(p.amount).toBe(0);
      expect(p.route).toBeNull();
      expect(p.routes.loop).toMatchObject({ available: false, reason: 'nothing to move' });
      expect(p.routes.convert).toMatchObject({ available: false, reason: 'nothing to move' });
    }
  });

  it('quotes the loop as amount x (1 - bid) + amount x taker + the pull fee, with the pull wait', () => {
    const p = plan(s, OPEN, PULL);
    expect(p.routes.loop.costUsd).toBeCloseTo(50 * 0.0001 + PULL_FEE_USD, 9);
    expect(p.routes.loop.waitSeconds).toBe(PULL_WAIT_SECONDS);
    expect(p.routes.loop.waitSeconds).toBe(400);
    const withFee = plan(s, { ...OPEN, spotTakerRate: 0.001 }, PULL);
    expect(withFee.routes.loop.costUsd).toBeCloseTo(50 * 0.0001 + 50 * 0.001 + PULL_FEE_USD, 9);
  });

  it('charges no spread when the bid is above 1', () => {
    const p = plan(s, { ...OPEN, bid: 1.0002 }, PULL);
    expect(p.routes.loop.costUsd).toBeCloseTo(PULL_FEE_USD, 9);
  });

  it('quotes convert as amount x 0.002, instant, and picks it for a small pull', () => {
    const p = plan(s, OPEN, PULL);
    expect(p.routes.convert).toMatchObject({ waitSeconds: 0, available: true, reason: null });
    expect(p.routes.convert.costUsd).toBeCloseTo(0.1, 9);
    expect(p.routes.loop.costUsd).toBeCloseTo(1.005, 9);
    expect(p.route).toBe('convert');
    expect(p.price).toBe(0.998);
    expect(p.receives).toBe(49.9);
    expect(p.shortfall).toBeNull();
    expect(p.borrowAfterUsd).toBe(0);
  });

  it('picks the loop for a big pull, where the $1 fee beats 20 bps, with the bid as the price and the sold USDT as receives', () => {
    const p = plan({ ...s, usdcEquity: 5000, usdcCash: 5000 }, OPEN, PULL);
    expect(p.routes.loop.costUsd).toBeCloseTo(1.5, 9);
    expect(p.routes.convert.costUsd).toBeCloseTo(10, 9);
    expect(p.route).toBe('loop');
    expect(p.price).toBe(0.9999);
    expect(p.receives).toBe(4998.5);
    expect(p.shortfall).toBeNull();
    expect(p.borrowAfterUsd).toBe(0);
    expect(p.savesPerDayUsd).toBe(0);
    expect(p.marginFreedUsd).toBe(0);
  });

  it('matches the live runs: the loop for 12 USDC at bid 1 costs the $1 fee, and convert at 2 cents wins', () => {
    const p = plan({ ...s, usdcEquity: 12, usdcCash: 12 }, { ...OPEN, bid: 1 }, PULL);
    expect(p.amount).toBe(12);
    expect(p.routes.loop).toMatchObject({ available: true, reason: null });
    expect(p.routes.loop.costUsd).toBeCloseTo(1, 9);
    expect(p.routes.convert.costUsd).toBeCloseTo(0.024, 9);
    expect(p.route).toBe('convert');
    expect(p.receives).toBe(11.97);
  });

  it('takes the spot taker fee out of the loop receives', () => {
    const p = plan({ ...s, usdcEquity: 5000, usdcCash: 5000 }, { ...OPEN, bid: 1, spotTakerRate: 0.001 }, PULL);
    expect(p.route).toBe('loop');
    expect(p.receives).toBe(4994);
  });

  it('is unavailable when the USDC transfer is disabled or missing', () => {
    const disabled = plan(s, { ...OPEN, usdcTransfer: { isDisabled: 1, minTransAmount: 11 } }, PULL);
    expect(disabled.routes.loop).toMatchObject({ available: false, reason: 'Gate has paused USDC transfers on CrossEx. Try again later.' });
    const missing = plan(s, { ...OPEN, usdcTransfer: null }, PULL);
    expect(missing.routes.loop).toMatchObject({ available: false, reason: 'Gate has paused USDC transfers on CrossEx. Try again later.' });
    expect(missing.route).toBe('convert');
  });

  it('is unavailable when the spot rule is not live or missing', () => {
    expect(plan(s, { ...OPEN, spotRule: { state: 'suspended' } }, PULL).routes.loop.reason).toBe(
      'The USDC/USDT spot market on Gate is not trading right now.',
    );
    expect(plan(s, { ...OPEN, spotRule: null }, PULL).routes.loop.reason).toBe('The USDC/USDT spot market on Gate is not trading right now.');
  });

  it('is unavailable when there is no spot bid, even with an ask', () => {
    for (const bid of [null, 0]) {
      const p = plan(s, { ...OPEN, bid }, PULL);
      expect(p.routes.loop).toMatchObject({ available: false, reason: 'No price for USDC/USDT on Gate spot right now.' });
      expect(p.route).toBe('convert');
      expect(p.price).toBe(0.998);
      expect(p.receives).toBe(49.9);
    }
  });

  it('is unavailable when the pull lands below the transfer minimum after the fee', () => {
    const p = plan({ ...s, usdcEquity: 11.5, usdcCash: 11.5 }, OPEN, PULL);
    expect(p.amount).toBe(11.5);
    expect(p.routes.loop.available).toBe(false);
    expect(p.routes.loop.reason).toBe('Too small to pull. Gate takes a flat $1 fee on the way out and needs at least 11 USDC to arrive. Pull at least 12 USDC.');
    expect(p.route).toBe('convert');
    const enough = plan({ ...s, usdcEquity: 12, usdcCash: 12 }, OPEN, PULL);
    expect(enough.routes.loop.available).toBe(true);
  });

  it('reports the first cause only', () => {
    const nothing = plan({ ...s, usdcEquity: 0 }, { ...OPEN, usdcTransfer: null, bid: null }, PULL);
    expect(nothing.routes.loop.reason).toBe('nothing to move');
    const disabled = plan(s, { ...OPEN, usdcTransfer: { isDisabled: 1, minTransAmount: 11 }, spotRule: null, bid: null }, PULL);
    expect(disabled.routes.loop.reason).toBe('Gate has paused USDC transfers on CrossEx. Try again later.');
    const notLive = plan(s, { ...OPEN, spotRule: { state: 'paused' }, bid: null }, PULL);
    expect(notLive.routes.loop.reason).toBe('The USDC/USDT spot market on Gate is not trading right now.');
  });
});
