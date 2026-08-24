/** The browser's half of the membership assertions: what survives a reload,
 * and the wire bytes the server must read back. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  encodeRows,
  legRefKey,
  loadRows,
  newPositionId,
  pruneRows,
  saveRows,
  withRow,
  type MembershipRow,
} from './partitionStore';

const ADDR = '0xAbCd';
const NOW = 1_800_000_000;

const PERP: MembershipRow = {
  positionId: 'a3f1c8d2',
  leg: { kind: 'perp', symbol: 'BINANCE_FUTURE_ETH_USDT' },
};
const BOROS: MembershipRow = {
  positionId: 'a3f1c8d2',
  leg: { kind: 'boros', marketId: 129 },
  qty: 0.013,
};
const ORPHAN: MembershipRow = { leg: { kind: 'perp', symbol: 'GATE_FUTURE_ETH_USDT' } };

/** The bytes tests/unit/boros-partition.test.ts pins on the server side. Both
 * copies encode the same rows, so a field added to one and not the other fails
 * a test instead of silently dropping every user's assertions. */
const GOLDEN =
  'eyJ2IjozLCJyIjpbeyJwIjoiYTNmMWM4ZDIiLCJrIjoicCIsInIiOiJCSU5BTkNFX0ZVVFVSRV9FVEhfVVNEVCJ9LHsicCI6ImEzZjFjOGQyIiwiayI6ImIiLCJyIjoxMjksInEiOjAuMDEzfSx7ImsiOiJwIiwiciI6IkdBVEVfRlVUVVJFX0VUSF9VU0RUIn1dfQ';

beforeEach(() => window.localStorage.clear());

describe('partitionStore', () => {
  it('round-trips rows per address, case-insensitively', () => {
    saveRows(ADDR, [PERP], NOW);
    expect(loadRows(ADDR.toLowerCase())).toEqual([PERP]);
    expect(loadRows('0xother')).toEqual([]);
  });

  it('drops the entry entirely when the last row is removed', () => {
    saveRows(ADDR, [PERP], NOW);
    saveRows(ADDR, [], NOW);
    expect(JSON.parse(window.localStorage.getItem('crossex.partition.v1') ?? '{}')).toEqual({});
  });

  it('prunes rows older than the retention window on the next write', () => {
    saveRows(ADDR, [PERP], NOW);
    saveRows('0xlater', [BOROS], NOW + 181 * 24 * 3600);
    expect(loadRows(ADDR)).toEqual([]);
  });

  it('ignores a corrupted store instead of throwing the view away', () => {
    window.localStorage.setItem('crossex.partition.v1', '{"0xabcd":{"rows":"nope"}}');
    expect(loadRows(ADDR)).toEqual([]);
  });

  it('keeps a missing qty missing across a reload', () => {
    // Absent means "all of it"; persisting it as 0 would turn a claim into a
    // detach on the next page load.
    saveRows(ADDR, [PERP], NOW);
    expect(loadRows(ADDR)[0].qty).toBeUndefined();
  });

  it('mints an id that is opaque, not derived from the legs', () => {
    const a = newPositionId();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(newPositionId());
  });
});

describe('withRow', () => {
  const leg = PERP.leg;

  it('assign replaces this position\'s claim on the leg', () => {
    const out = withRow([{ positionId: 'aa', leg, qty: 1 }], {
      mode: 'assign',
      positionId: 'aa',
      leg,
      qty: 2,
    });
    expect(out).toEqual([{ positionId: 'aa', leg, qty: 2 }]);
  });

  it('assign leaves ANOTHER position\'s claim alone — that is a shared leg', () => {
    const out = withRow([{ positionId: 'bb', leg, qty: 1 }], {
      mode: 'assign',
      positionId: 'aa',
      leg,
      qty: 2,
    });
    expect(out).toHaveLength(2);
  });

  it('assign clears an orphan on the same leg, which it contradicts', () => {
    const out = withRow([{ leg }], { mode: 'assign', positionId: 'aa', leg });
    expect(out).toEqual([{ positionId: 'aa', leg }]);
  });

  it('release drops only this position\'s claim', () => {
    const out = withRow(
      [
        { positionId: 'aa', leg, qty: 1 },
        { positionId: 'bb', leg, qty: 1 },
      ],
      { mode: 'release', positionId: 'aa', leg },
    );
    expect(out).toEqual([{ positionId: 'bb', leg, qty: 1 }]);
  });

  it('orphan is exclusive — no position may still claim it', () => {
    const out = withRow(
      [
        { positionId: 'aa', leg, qty: 1 },
        { positionId: 'bb', leg, qty: 1 },
      ],
      { mode: 'orphan', leg },
    );
    expect(out).toEqual([{ leg }]);
  });

  it('orphaning a SHARE leaves the other positions holding theirs', () => {
    // Detaching one card's slice of a shared leg must not strip the card next
    // door. Orphaning 1 of a leg 'aa' and 'bb' each hold 1 of leaves bb's.
    const out = withRow(
      [
        { positionId: 'aa', leg, qty: 1 },
        { positionId: 'bb', leg, qty: 1 },
      ],
      { mode: 'orphan', leg, qty: 1 },
    );
    expect(out).toEqual([
      { positionId: 'aa', leg, qty: 1 },
      { positionId: 'bb', leg, qty: 1 },
      { leg, qty: 1 },
    ]);
  });

  it('two shares detached separately add up instead of overwriting', () => {
    const once = withRow([{ positionId: 'bb', leg, qty: 1 }], { mode: 'orphan', leg, qty: 1 });
    const twice = withRow(once, { mode: 'orphan', leg, qty: 2 });
    expect(twice.filter((r) => r.positionId === undefined)).toEqual([{ leg, qty: 3 }]);
  });

  it('a whole-leg orphan still wins over a partial one', () => {
    const partial = withRow([], { mode: 'orphan', leg, qty: 1 });
    expect(withRow(partial, { mode: 'orphan', leg })).toEqual([{ leg }]);
  });

  /**
   * ⚠ Automatic is SCOPED, like orphan and for the same reason.
   *
   * It used to drop every row naming the leg, so choosing it on the unclaimed
   * remainder of a shared leg also deleted the pin another card held — a card
   * the user never touched — and the solver then swept the whole venue leg
   * into one position.
   */
  it('auto forgets one position\'s claim and leaves the rest of the leg alone', () => {
    const out = withRow([{ positionId: 'aa', leg }, { positionId: 'bb', leg }, { leg }, BOROS], {
      mode: 'auto',
      leg,
      positionId: 'aa',
    });
    expect(out).toEqual([{ positionId: 'bb', leg }, { leg }, BOROS]);
  });

  it('auto with no position forgets the ORPHAN rows — what it means on an unhedged card', () => {
    const out = withRow([{ positionId: 'aa', leg }, { leg }, BOROS], { mode: 'auto', leg });
    expect(out).toEqual([{ positionId: 'aa', leg }, BOROS]);
  });

  it('auto on a leg this position never claimed changes nothing', () => {
    const rows = [{ positionId: 'aa', leg }, BOROS];
    expect(withRow(rows, { mode: 'auto', leg, positionId: 'zz' })).toEqual(rows);
  });

  it('keys a leg by the venue\'s own identifier', () => {
    expect(legRefKey({ kind: 'perp', symbol: 'X' })).not.toBe(legRefKey({ kind: 'boros', marketId: 1 }));
    // Two Binance ETH books under different quote coins are different legs.
    expect(legRefKey({ kind: 'perp', symbol: 'BINANCE_FUTURE_ETH_USDT' })).not.toBe(
      legRefKey({ kind: 'perp', symbol: 'BINANCE_FUTURE_ETH_USDC' }),
    );
  });
});

describe('encodeRows', () => {
  it('encodes to the golden vector the server copy must also produce', () => {
    expect(encodeRows([PERP, BOROS, ORPHAN])).toBe(GOLDEN);
  });

  it('encodes to base64url, and to nothing when empty', () => {
    expect(encodeRows([PERP])).not.toMatch(/[+/=]/);
    expect(encodeRows([])).toBe('');
  });
});

/**
 * The delete `returns.ts:applyMembership` documents but never performed.
 *
 * A row names a LEG, so a row outliving its leg does not go quiet — it lies in
 * wait for the next position to use that symbol. Closing a hand-grouped
 * position and re-opening the same market used to reconstitute the dead one.
 */
describe('pruneRows', () => {
  const liveSet = (...keys: string[]) => {
    const live = new Set(keys);
    return (leg: MembershipRow['leg']) => live.has(legRefKey(leg));
  };

  it('drops rows naming a leg no feed reports any more', () => {
    expect(pruneRows([PERP, BOROS, ORPHAN], liveSet('boros:129'))).toEqual([BOROS]);
  });

  it('drops an ORPHAN row too — a leg that closed is not unhedged exposure', () => {
    expect(pruneRows([ORPHAN], liveSet())).toEqual([]);
  });

  it('returns the same array when nothing is stale, so no write happens', () => {
    const rows = [PERP, BOROS];
    expect(
      pruneRows(rows, liveSet('perp:BINANCE_FUTURE_ETH_USDT', 'boros:129')),
    ).toBe(rows);
  });

  it('keeps every row of a kind whose feed answers "nothing new to say"', () => {
    // What a perp poll does to Boros rows: says true, changes nothing. The two
    // feeds are 26s apart and neither may speak for the other.
    const rows = [PERP, BOROS];
    const perpFeedSaysLive = (leg: MembershipRow['leg']) =>
      leg.kind === 'boros' || legRefKey(leg) === 'perp:BINANCE_FUTURE_ETH_USDT';
    expect(pruneRows(rows, perpFeedSaysLive)).toBe(rows);
  });

  it('re-opening the same market does not resurrect the closed position', () => {
    // The bug, end to end at this layer: BINANCE_FUTURE_ETH_USDT closes, the
    // rows are pruned, and the symbol coming back finds nothing claiming it.
    const pruned = pruneRows([PERP, BOROS], liveSet('boros:129'));
    const reopened = liveSet('perp:BINANCE_FUTURE_ETH_USDT', 'boros:129');
    expect(pruneRows(pruned, reopened).some((r) => r.leg.kind === 'perp')).toBe(false);
  });
});
