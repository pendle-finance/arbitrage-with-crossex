/**
 * Rows the reader already holds the perps for: which rows match, which tag
 * they carry, and what zeroing the perp entry cost does to the figures. Every
 * expectation is hand-derived from the server's identities.
 */
import { describe, expect, it } from 'vitest';
import { makeOpportunityGroup, makeOpportunityPair, OPP_NT } from '../test/fixtures';
import { heldPerpsOf, heldTagFor, repriceHeld } from './heldPerps';
import { toRows } from './opportunityFilters';

const DAY = 86_400;
const NOW = 1_800_000_000;

describe('heldPerpsOf / heldTagFor', () => {
  // The fixture pair is SHORT Hyperliquid / LONG Binance on ETH.
  const pair = makeOpportunityPair();
  const asset = 'ETH';
  const rowMaturity = NOW + 40 * DAY;

  const SOON = NOW + 5 * DAY;
  const legsAt = (maturity: number) => [{ venue: 'Binance', maturity }, { venue: 'Hyperliquid', maturity }];

  it('matches on asset, both venues AND the sides held', () => {
    const held = heldPerpsOf([
      { base: 'ETH', perps: [{ venue: 'BINANCE', side: 'LONG' }, { venue: 'HYPERLIQUID', side: 'SHORT' }], boros: legsAt(SOON) },
    ]);
    expect(heldTagFor(held, asset, pair, rowMaturity)).toBe('rollover');
    // Another asset on the same venues is not this pair.
    expect(heldTagFor(held, 'BTC', pair, rowMaturity)).toBeNull();
  });

  it('perps with NO rate legs behind them are not a hedge to roll', () => {
    const held = heldPerpsOf([
      { base: 'ETH', perps: [{ venue: 'BINANCE', side: 'LONG' }, { venue: 'HYPERLIQUID', side: 'SHORT' }], boros: [] },
    ]);
    expect(heldTagFor(held, asset, pair, rowMaturity)).toBeNull();
  });

  it('does NOT match the mirror image: flipping sides means re-opening both perps', () => {
    const held = heldPerpsOf([
      { base: 'ETH', perps: [{ venue: 'BINANCE', side: 'SHORT' }, { venue: 'HYPERLIQUID', side: 'LONG' }], boros: legsAt(SOON) },
    ]);
    expect(heldTagFor(held, asset, pair, rowMaturity)).toBeNull();
  });

  it('one perp alone is not the pair', () => {
    const held = heldPerpsOf([{ base: 'ETH', perps: [{ venue: 'HYPERLIQUID', side: 'SHORT' }], boros: legsAt(SOON) }]);
    expect(heldTagFor(held, asset, pair, rowMaturity)).toBeNull();
  });

  it('tags only LATER maturities: holding Sept tags Oct and Nov, holding Oct tags only Nov', () => {
    const perps = [{ venue: 'BINANCE', side: 'LONG' as const }, { venue: 'HYPERLIQUID', side: 'SHORT' as const }];
    const SEPT = NOW + 5 * DAY;
    const OCT = NOW + 40 * DAY;
    const NOV = NOW + 68 * DAY;
    // Boros names venues in display case; the perp feed in upper case.
    const holdsSept = heldPerpsOf([{ base: 'ETH', perps, boros: legsAt(SEPT) }]);
    expect(heldTagFor(holdsSept, asset, pair, SEPT)).toBeNull(); // the position itself
    expect(heldTagFor(holdsSept, asset, pair, OCT)).toBe('rollover');
    expect(heldTagFor(holdsSept, asset, pair, NOV)).toBe('rollover');
    const holdsOct = heldPerpsOf([{ base: 'ETH', perps, boros: legsAt(OCT) }]);
    expect(heldTagFor(holdsOct, asset, pair, SEPT)).toBeNull(); // sooner is not a roll
    expect(heldTagFor(holdsOct, asset, pair, OCT)).toBeNull();
    expect(heldTagFor(holdsOct, asset, pair, NOV)).toBe('rollover');
    // A rate leg on one venue only is not a hedge to roll.
    const one = heldPerpsOf([{ base: 'ETH', perps, boros: [{ venue: 'Binance', maturity: SEPT }] }]);
    expect(heldTagFor(one, asset, pair, OCT)).toBeNull();
  });
});

describe('repriceHeld', () => {
  it('takes the perp entry fee and slip out of the total and re-derives every figure from it', () => {
    const pair = makeOpportunityPair();
    const notionalUsd = 10_000;
    const years = pair.secondsToMaturity / (365 * 86_400);
    const out = repriceHeld(pair, notionalUsd);

    const saved = (pair.costs.perpEntryFeesUsd ?? 0) + (pair.costs.perpEntrySlippageUsd ?? 0);
    expect(saved).toBeGreaterThan(0);
    expect(out.costs.perpEntryFeesUsd).toBe(0);
    expect(out.costs.perpEntrySlippageUsd).toBe(0);
    expect(out.costs.totalUsd).toBeCloseTo((pair.costs.totalUsd as number) - saved, 9);
    // The rest of the ledger is untouched.
    expect(out.costs.borosTakerFeeUsd).toBe(pair.costs.borosTakerFeeUsd);
    expect(out.costs.perpExitFeesUsd).toBe(pair.costs.perpExitFeesUsd);
    // Profit rises by exactly what was saved; capital does not move.
    expect(out.estProfitUsd).toBeCloseTo((pair.estProfitUsd as number) + saved, 6);
    expect(out.capitalUsd).toBe(pair.capitalUsd);
    expect(out.netFixedAprOnCapital).toBeCloseTo((out.estProfitUsd as number) / ((pair.capitalUsd as number) * years), 9);
    expect(out.netFixedApr).toBeCloseTo((pair.execSpreadApr as number) - (out.costs.totalUsd as number) / (notionalUsd * years), 9);
  });

  it('leaves a pair the server could not price alone', () => {
    const base = makeOpportunityPair();
    const unpriced = { ...base, costs: { ...base.costs, totalUsd: null } };
    expect(repriceHeld(unpriced, 10_000)).toBe(unpriced);
  });
});

describe('toRows with holdings', () => {
  it('RANKS the held pair as re-priced and pins it, but hands the card the pair as served', () => {
    const mine = makeOpportunityPair();
    const stranger = {
      ...makeOpportunityPair(),
      shortLeg: { ...mine.shortLeg, marketId: 901, venue: 'OKX', crossexVenue: 'OKX' },
      netFixedAprOnCapital: (mine.netFixedAprOnCapital as number) * 10,
    };
    const group = makeOpportunityGroup({ pairs: [stranger, mine] });
    const sooner = group.maturity - 30 * DAY;
    const held = heldPerpsOf([
      {
        base: group.underlying,
        perps: [{ venue: 'BINANCE', side: 'LONG' }, { venue: 'HYPERLIQUID', side: 'SHORT' }],
        boros: [{ venue: 'Binance', maturity: sooner }, { venue: 'Hyperliquid', maturity: sooner }],
      },
    ]);
    const notionalUsd = OPP_NT / (mine.secondsToMaturity / (365 * 86_400));

    const plain = toRows([group]);
    expect(plain.map((r) => r.held)).toEqual([null, null]);
    expect(plain[0].pair).toBe(stranger);

    const rows = toRows([group], undefined, { held, notionalUsd });
    expect(rows[0].held).toBe('rollover');
    // The card owns the toggle, so it gets the server's own pricing …
    expect(rows[0].pair).toBe(mine);
    // … while the rank (and the viability test) used the zero-entry figure.
    expect(rows[0].apr).toBeCloseTo(repriceHeld(mine, notionalUsd).netFixedAprOnCapital as number, 12);
    expect(rows[0].apr).toBeGreaterThan(mine.netFixedAprOnCapital as number);
    expect(rows[1].held).toBeNull();
    expect(rows[1].pair).toBe(stranger);
  });
});
