/**
 * Which trades were placed together.
 *
 * Driven entirely through `bindExecutions`, the module's only real question.
 * The scoring internals used to be exported so they could be asserted one by
 * one; every one of those properties is visible in what does or does not bind,
 * so testing them separately only pinned the implementation in place.
 */
import { describe, expect, it } from 'vitest';
import { bindExecutions, legsBoundTogether, type Atom } from '../../src/core/boros/grouping';

const T = 1_787_300_000;

const atom = (over: Partial<Atom> & Pick<Atom, 'id' | 'legKey' | 'floating'>): Atom => ({
  venue: 'BINANCE',
  base: 'ETH',
  qty: 100,
  rate: 0.05,
  at: { kind: 'at', sec: T },
  ...over,
});

/** The live shape: a Boros long and a Boros short, one transaction. */
const pair = (over: { gap?: number; qtyB?: number; atB?: Atom['at'] } = {}) => [
  atom({ id: 'a', legKey: 'boros:129', venue: 'BINANCE', floating: +100 }),
  atom({
    id: 'b',
    legKey: 'boros:128',
    venue: 'HYPERLIQUID',
    floating: -100,
    qty: over.qtyB ?? 100,
    at: over.atB ?? { kind: 'at', sec: T + (over.gap ?? 0) },
  }),
];

const boundIds = (atoms: Atom[], opts?: Parameters<typeof bindExecutions>[1]) =>
  bindExecutions(atoms, opts).map((e) => e.atomIds);

describe('what binds', () => {
  it('a same-second, equal-size, opposite-side pair — the bug this exists for', () => {
    const atoms = pair();
    expect(boundIds(atoms)).toEqual([['a', 'b']]);
    // …and the two LEGS are now known to belong on one card.
    expect(legsBoundTogether(atoms, bindExecutions(atoms)).get('boros:129')).toEqual([
      'boros:129',
      'boros:128',
    ]);
  });

  it('a minute apart, sizes within 1%', () => {
    expect(boundIds(pair({ gap: 30, qtyB: 100.5 }))).toEqual([['a', 'b']]);
  });

  it('identity, however far apart — the most improbable coincidence there is', () => {
    const [a, b] = pair({ gap: 100_000 });
    expect(boundIds([{ ...a, identity: 'tx1' }, { ...b, identity: 'tx1' }])).toEqual([['a', 'b']]);
  });
});

describe('what does not', () => {
  it('same side — two longs are not a hedge', () => {
    const [a, b] = pair();
    expect(boundIds([a, { ...b, floating: +100 }])).toEqual([]);
  });

  it('different coins', () => {
    const [a, b] = pair();
    expect(boundIds([a, { ...b, base: 'BTC' }])).toEqual([]);
  });

  it('ten minutes apart — a guess must not create an indivisible object', () => {
    expect(boundIds(pair({ gap: 600 }))).toEqual([]);
  });

  it('same instant but twice the size — coincidence in time alone is not enough', () => {
    expect(boundIds(pair({ qtyB: 200 }))).toEqual([]);
  });

  it('a TIME BOUND — a reconstructed prefix cannot claim proximity', () => {
    // "At or before T" says nothing about how far back it goes; reading it as
    // an instant would hand the prior block the tightest band in the table.
    expect(boundIds(pair({ atB: { kind: 'before', sec: T } }))).toEqual([]);
  });
});

describe('choosing between candidates', () => {
  it('takes the closer counterparty', () => {
    const atoms = [
      atom({ id: 'long', legKey: 'boros:129', floating: +100 }),
      atom({ id: 'near', legKey: 'boros:128', venue: 'HYPERLIQUID', floating: -100, at: { kind: 'at', sec: T + 2 } }),
      atom({ id: 'far', legKey: 'boros:127', venue: 'OKX', floating: -100, at: { kind: 'at', sec: T + 50 } }),
    ];
    expect(boundIds(atoms)).toEqual([['long', 'near']]);
  });

  it('refuses a third leg that makes the execution MORE directional', () => {
    const atoms = [
      ...pair(),
      atom({ id: 'c', legKey: 'boros:127', venue: 'OKX', floating: -100, at: { kind: 'at', sec: T + 1 } }),
    ];
    // a+b already nets to 0; another short would take it to −100.
    expect(boundIds(atoms).flat()).not.toContain('c');
  });

  it('is deterministic — the same book always binds the same way', () => {
    const atoms = pair({ gap: 1 });
    expect(bindExecutions(atoms)).toEqual(bindExecutions([...atoms].reverse()));
  });
});

describe('truncated history', () => {
  /**
   * A band is a claim about what ELSE was placed nearby — an argument from
   * absence, which truncation answers wrongly and confidently.
   */
  it('caps inferred pairings at weak, so nothing binds', () => {
    expect(boundIds(pair(), { historyComplete: false })).toEqual([]);
  });

  it('still binds on identity — presence survives truncation', () => {
    const [a, b] = pair({ gap: 100_000 });
    expect(
      boundIds([{ ...a, identity: 'tx1' }, { ...b, identity: 'tx1' }], { historyComplete: false }),
    ).toEqual([['a', 'b']]);
  });
});
