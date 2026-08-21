/** The browser's half of the membership assertions: what survives a reload,
 * and the wire bytes the server must read back. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  encodeRows,
  legRefKey,
  loadRows,
  newPositionId,
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

  it('auto forgets everything said about the leg', () => {
    const out = withRow([{ positionId: 'aa', leg }, { leg }, BOROS], { mode: 'auto', leg });
    expect(out).toEqual([BOROS]);
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
