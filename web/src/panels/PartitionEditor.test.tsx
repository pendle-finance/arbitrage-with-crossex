/** The membership editor: what a position's legs look like on a card, and what
 * each control asserts. Prop-driven — no query client needed. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeStrategyLeg, makeStrategyRollup } from '../test/fixtures';
import { LegAssignment, SplitChip, legRefOf, type LegAssertion } from './PartitionEditor';

afterEach(cleanup);

const HL_PERP = 'HYPERLIQUID_FUTURE_ETH_USDC';
const BIN_PERP = 'BINANCE_FUTURE_ETH_USDT';

/** A strategy holding 60% of a shared HYPERLIQUID short against a whole
 * BINANCE long, plus the Boros leg it locked. */
const shared = (over: Parameters<typeof makeStrategyRollup>[0] = {}) =>
  makeStrategyRollup({
    strategyId: 'ETH#BINANCE-HYPERLIQUID#exec',
    base: 'ETH',
    attribution: { source: 'fill-history', confidence: 'measured', pinned: false },
    legs: [
      makeStrategyLeg({ kind: 'perp', venue: 'HYPERLIQUID', side: 'SHORT', notionalToken: 300, share: 0.6, symbol: HL_PERP }),
      makeStrategyLeg({ kind: 'perp', venue: 'BINANCE', side: 'LONG', notionalToken: 300, share: 1, symbol: BIN_PERP }),
      makeStrategyLeg({ kind: 'boros', venue: 'BINANCE', side: 'LONG', notionalToken: 300, share: 1, marketId: 129 }),
    ],
    ...over,
  });

const legOf = (venue: string, kind: 'perp' | 'boros') =>
  shared().legs.find((l) => l.venue === venue && l.kind === kind)!;

/** The control as the card mounts it: in one leg's "Belongs to" cell. */
const mount = (
  venue: string,
  kind: 'perp' | 'boros',
  props: Partial<Parameters<typeof LegAssignment>[0]> = {},
) =>
  render(
    <LegAssignment leg={legOf(venue, kind)} strategyId={shared().strategyId} {...props} />,
  );

/** Open the dialog from the row's trigger. */
const openDialog = () => fireEvent.click(screen.getByRole('button'));

describe('legRefOf', () => {
  it('names a perp by symbol and a Boros leg by marketId', () => {
    expect(legRefOf(makeStrategyLeg({ kind: 'perp', symbol: 'X' }))).toEqual({ kind: 'perp', symbol: 'X' });
    expect(legRefOf(makeStrategyLeg({ kind: 'boros', marketId: 7 }))).toEqual({ kind: 'boros', marketId: 7 });
  });

  it('refuses to name a leg the payload cannot address', () => {
    // Without an identifier there is no row that could refer to it, and a
    // control that writes an unusable assertion is worse than no control.
    expect(legRefOf(makeStrategyLeg({ kind: 'perp', symbol: undefined }))).toBeNull();
    expect(legRefOf(makeStrategyLeg({ kind: 'boros', marketId: undefined }))).toBeNull();
  });
});

describe('SplitChip', () => {
  it('says nothing when the strategy owns its legs outright', () => {
    const { container } = render(<SplitChip s={makeStrategyRollup()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('calls a measured split measured, and a proposed one unconfirmed', () => {
    render(<SplitChip s={shared()} />);
    expect(screen.getByText('split measured')).toBeInTheDocument();
    cleanup();
    render(
      <SplitChip
        s={shared({ attribution: { source: 'proximity', confidence: 'unconfirmed', pinned: false } })}
      />,
    );
    expect(screen.getByText('split unconfirmed')).toBeInTheDocument();
  });

  it('names the SOURCE of the grouping, not its owner', () => {
    // All three chips answer "how was this grouping arrived at". "yours" said
    // nothing — every position on the page belongs to the user.
    render(<SplitChip s={shared({ attribution: { source: 'user', confidence: 'measured', pinned: true } })} />);
    expect(screen.getByText('grouped by you')).toBeInTheDocument();
  });
});

describe('LegAssignment', () => {
  it('states the fact without an affordance when no handler is wired', () => {
    mount('BINANCE', 'perp');
    expect(screen.getByText('this position')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a shared leg as its own size against the venue total', () => {
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn() });
    // 60% of 500 = 300 held; the fraction is the information, so both appear.
    expect(screen.getByRole('button').textContent).toMatch(/300/);
    expect(screen.getByRole('button').textContent).toMatch(/500/);
  });

  it('holds Confirm until something actually changes', () => {
    mount('BINANCE', 'perp', { onAssert: vi.fn() });
    openDialog();
    // Opened on the status quo: confirming would assert what is already true.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Nothing/ }));
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('drops the amount question when the grouper is put in charge', () => {
    mount('BINANCE', 'perp', { onAssert: vi.fn() });
    openDialog();
    expect(screen.getByText('How much of it?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Automatic/ }));
    // Automatic means the grouper decides the split, so asking for a number
    // would be asking for something that is then discarded.
    expect(screen.queryByText('How much of it?')).toBeNull();
  });

  it('emits an auto assertion for the leg it is about', () => {
    const onAssert = vi.fn<(a: LegAssertion) => void>();
    mount('BINANCE', 'perp', { onAssert });
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: /Automatic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onAssert).toHaveBeenCalledWith({
      mode: 'auto',
      leg: { kind: 'perp', symbol: BIN_PERP },
    });
  });
});


/**
 * Three behaviours the rewrite kept but stopped testing.
 *
 * The old suite covered move / orphan / unit-labelling; `LegMembership` was
 * replaced by `LegAssignment` and those went with it, even though all three
 * are still live. Unit labelling in particular is the class of bug that has
 * bitten this codebase twice (a collateral quantity read as a base quantity),
 * so it is the last thing that should be running untested.
 */
describe('LegAssignment — behaviours the rewrite kept but stopped testing', () => {
  const openDialog = () => fireEvent.click(screen.getByTitle(/open on/));

  it('MOVES a leg to another position — the correction the buttons alone cannot express', () => {
    const onAssert = vi.fn();
    mount('HYPERLIQUID', 'perp', {
      onAssert,
      destinations: [{ id: 'ETH#OTHER#exec', label: 'ETH · OKX ⇄ Gate' }],
    });
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: /ETH · OKX ⇄ Gate/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onAssert).toHaveBeenCalledTimes(1);
    const a = onAssert.mock.calls[0][0] as LegAssertion;
    // The destination is the whole point: without it this is a no-op that
    // silently leaves the leg where it was.
    expect(a.mode).toBe('assign');
    if (a.mode !== 'assign') throw new Error('expected an assign');
    expect(a.to).toBe('ETH#OTHER#exec');
    expect(a.leg).toEqual(legRefOf(legOf('HYPERLIQUID', 'perp')));
  });

  it('ORPHANS a leg — "nothing" is a real answer, not a missing one', () => {
    const onAssert = vi.fn();
    mount('HYPERLIQUID', 'perp', { onAssert });
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: /leave it unassigned/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onAssert).toHaveBeenCalledTimes(1);
    const a = onAssert.mock.calls[0][0] as LegAssertion;
    // Unassigned is its OWN mode — not an assign carrying an empty target.
    expect(a.mode).toBe('orphan');
    expect(a.leg).toEqual(legRefOf(legOf('HYPERLIQUID', 'perp')));
  });

  it('labels the amount in the unit THAT LEG is counted in', () => {
    // A perp is counted in its BASE coin; a Boros leg in its COLLATERAL. They
    // are the same number only when a market is margined in its own base, so
    // borrowing the other leg's unit is how a size ends up wrong by a price.
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn() });
    openDialog();
    // The perp is counted in the BASE coin.
    const perp = legOf('HYPERLIQUID', 'perp');
    expect(screen.getByText(/open on HYPERLIQUID/)).toHaveTextContent(perp.base ?? 'HYPE');

    cleanup();

    mount('BINANCE', 'boros', { onAssert: vi.fn() });
    openDialog();
    // The Boros fixture's collateral, NOT the strategy's ETH base.
    // The Boros leg is counted in its COLLATERAL — a different unit from the
    // perp above, on the same card. Reading one off the other is how a size
    // ends up wrong by a coin price.
    const boros = legOf('BINANCE', 'boros');
    expect(boros.collateral).toBeDefined();
    expect(screen.getByText(/open on BINANCE/)).toHaveTextContent(boros.collateral!);
    // The two units genuinely differ here, which is what makes this a guard
    // rather than a tautology.
    expect(boros.collateral).not.toBe(legOf('HYPERLIQUID', 'perp').base);
  });
});
