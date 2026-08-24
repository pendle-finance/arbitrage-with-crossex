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
      makeStrategyLeg({ kind: 'boros', venue: 'BINANCE', side: 'LONG', notionalToken: 300, share: 0.5, marketId: 129 }),
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
      destinations: [{ id: 'ETH#OTHER#exec', label: 'ETH · OKX ⇄ Gate', borosMaturity: null }],
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

/**
 * Correcting a leg's ENTRY — the price a perp paid, the rate a Boros leg
 * locked.
 *
 * The venue reports ONE blended entry across every strategy sharing a leg, so
 * a card holding part of it cannot say what it actually paid. This is where
 * the user says. What the venue reports never changes; the assertion only
 * decides how that total is divided — see entryOverrideStore.
 */
describe('LegAssignment — correcting the entry', () => {
  const openDialog = () => fireEvent.click(screen.getByTitle(/open on/));
  const entryField = (rate = false) =>
    screen.getByLabelText(new RegExp(`entry ${rate ? 'rate' : 'price'} for this position`));

  it('asks for a PRICE on a perp and a RATE on a Boros leg', () => {
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), venueEntry: 2440 });
    openDialog();
    expect(screen.getByText('What did it cost?')).toBeInTheDocument();
    expect(screen.getByText('per coin')).toBeInTheDocument();

    cleanup();

    mount('BINANCE', 'boros', { onAssert: vi.fn(), venueEntry: 0.0544 });
    openDialog();
    expect(screen.getByText('What rate did it lock?')).toBeInTheDocument();
    expect(screen.getByText('% APR')).toBeInTheDocument();
  });

  it('emits the typed price as an entry assertion', () => {
    const onAssert = vi.fn<(a: LegAssertion) => void>();
    mount('HYPERLIQUID', 'perp', { onAssert, venueEntry: 2440 });
    openDialog();
    fireEvent.change(entryField(), { target: { value: '2457.77' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onAssert).toHaveBeenCalledWith({
      mode: 'entry',
      leg: legRefOf(legOf('HYPERLIQUID', 'perp')),
      value: 2457.77,
    });
  });

  it('converts a Boros rate from percent to a fraction', () => {
    // Nobody types 0.0544 for 5.44%, and the store holds fractions — so the
    // conversion has to happen exactly once, here at the UI edge.
    const onAssert = vi.fn<(a: LegAssertion) => void>();
    mount('BINANCE', 'boros', { onAssert, venueEntry: 0.0544 });
    openDialog();
    fireEvent.change(entryField(true), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const a = onAssert.mock.calls[0][0] as LegAssertion;
    if (a.mode !== 'entry') throw new Error('expected an entry assertion');
    expect(a.value).toBeCloseTo(0.09, 12);
  });

  it('seeds from what was ASSERTED, never from the venue average', () => {
    // Pre-filling the venue's number would turn "open the dialog and press
    // Confirm" into an assertion the user never made.
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), venueEntry: 2440 });
    openDialog();
    expect(entryField()).toHaveValue(null);

    cleanup();

    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), venueEntry: 2440, entryOverride: 2457.77 });
    openDialog();
    expect(entryField()).toHaveValue(2457.77);
  });

  it('clears an assertion by emptying the field', () => {
    const onAssert = vi.fn<(a: LegAssertion) => void>();
    mount('HYPERLIQUID', 'perp', { onAssert, venueEntry: 2440, entryOverride: 2457.77 });
    openDialog();
    fireEvent.change(entryField(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onAssert).toHaveBeenCalledWith({
      mode: 'entry',
      leg: legRefOf(legOf('HYPERLIQUID', 'perp')),
      value: null,
    });
  });

  it('refuses a non-positive entry — that is not a fill', () => {
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), venueEntry: 2440 });
    openDialog();
    fireEvent.change(entryField(), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByText(/above zero, or leave it empty/)).toBeInTheDocument();
  });

  it('does not pin the grouping when ONLY the entry changed', () => {
    // Re-asserting "this position, all of it" would freeze a split the solver
    // was still free to revise — a side effect the user never asked for.
    const onAssert = vi.fn<(a: LegAssertion) => void>();
    mount('HYPERLIQUID', 'perp', { onAssert, venueEntry: 2440 });
    openDialog();
    fireEvent.change(entryField(), { target: { value: '2457.77' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onAssert).toHaveBeenCalledTimes(1);
    expect((onAssert.mock.calls[0][0] as LegAssertion).mode).toBe('entry');
  });

  it('is not asked once the leg is going somewhere else', () => {
    // An entry is what THIS card paid; it means nothing for a leg it is
    // handing to another card or back to the grouper.
    mount('HYPERLIQUID', 'perp', {
      onAssert: vi.fn(),
      venueEntry: 2440,
      destinations: [{ id: 'ETH#OTHER#exec', label: 'ETH · OKX ⇄ Gate', borosMaturity: null }],
    });
    openDialog();
    expect(screen.getByText('What did it cost?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /ETH · OKX ⇄ Gate/ }));
    expect(screen.queryByText('What did it cost?')).toBeNull();
  });

  it('says plainly that fees stay pro-rated by size', () => {
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), venueEntry: 2440 });
    openDialog();
    expect(screen.getByText(/Fees stay pro-rated by size/)).toBeInTheDocument();
  });
});

/**
 * The three defects the flow-5-9 re-audit found in the entry editor.
 *
 * All three shared one root cause: `entryOverrideStore` was written, unit
 * tested and then never called from the app, so the conservation guarantee the
 * dialog PROMISED in prose was not actually enforced by anything.
 */
describe('LegAssignment — entry editor: regressions from the re-audit', () => {
  const openShared = () => fireEvent.click(screen.getByTitle(/of the .* open on/));
  const entryField = () => screen.getByLabelText(/entry price for this position/);

  it('REFUSES an assertion that leaves the rest of the leg below zero', () => {
    // The fixture holds 180 of 300 on HYPERLIQUID at a venue blend of 2440.
    // Claiming 100000 implies the other 120 was bought at a negative price.
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), venueEntry: 2440 });
    openShared();
    fireEvent.change(entryField(), { target: { value: '100000' } });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByText(/Nothing could balance that/)).toBeInTheDocument();
    // And the promise that cannot be kept must not still be on screen.
    expect(screen.queryByText(/keeps the venue average at/)).toBeNull();
    // 100000 IS above zero — showing the not-a-number message here told the
    // user to do what they had already done.
    expect(screen.queryByText(/above zero, or leave it empty/)).toBeNull();
  });

  it('names the sibling\'s RESULTING entry, not just the mechanism', () => {
    // The tester's bail-out point: "takes whatever balances back to 2440" left
    // them to compute what was being written into a position they could not
    // see. The fixture holds 180 of 300 at a venue blend of 2440, so asserting
    // 2400 puts the other 120 at (2440*300 − 2400*180)/120 = 2500.
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), venueEntry: 2440 });
    openShared();
    fireEvent.change(entryField(), { target: { value: '2400' } });
    expect(screen.getByText(/becomes/)).toHaveTextContent('2500');
    expect(screen.getByText(/keeps the venue average at/)).toBeInTheDocument();
  });

  it('still accepts an assertion the remainder CAN absorb', () => {
    // The guard must not be so eager it blocks ordinary corrections.
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), venueEntry: 2440 });
    openShared();
    fireEvent.change(entryField(), { target: { value: '2457.77' } });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    // The reconciliation line now names the OUTCOME rather than the mechanism.
    expect(screen.getByText(/keeps the venue average at/)).toBeInTheDocument();
  });

  it('stops asking for an entry once the amount is raised to the WHOLE leg', () => {
    // Claiming all of a shared leg leaves no remainder, so there is nothing to
    // absorb a correction — and the form was still promising "the other 0.01
    // becomes 2461.85" while the user claimed all 0.02.
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), venueEntry: 2440 });
    openShared();
    expect(screen.getByText('What did it cost?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.queryByText('What did it cost?')).toBeNull();
  });

  it('asks again when the amount drops back below the whole leg', () => {
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), venueEntry: 2440 });
    openShared();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.queryByText('What did it cost?')).toBeNull();
    fireEvent.change(screen.getByLabelText(/size for this position/), {
      target: { value: '100' },
    });
    expect(screen.getByText('What did it cost?')).toBeInTheDocument();
  });

  it('does not ask for an entry on a leg this position owns outright', () => {
    // No "rest of the leg" exists to absorb a correction, so the question — and
    // the reconciliation promise under it — would both be false.
    mount('BINANCE', 'perp', { onAssert: vi.fn(), venueEntry: 2440 });
    fireEvent.click(screen.getByTitle(/holds all/));
    expect(screen.queryByText('What did it cost?')).toBeNull();
  });

  it('shows a Boros rate to 2dp, not to eight decimals', () => {
    mount('BINANCE', 'boros', { onAssert: vi.fn(), venueEntry: 0.0590778377 });
    fireEvent.click(screen.getByTitle(/of the .* open on/));
    expect(screen.getByText(/reports 5\.91% across the whole position/)).toBeInTheDocument();
  });
});

/**
 * ONE MATURITY PER POSITION.
 *
 * A solved card is single-maturity structurally — cohorts are keyed
 * `(base, maturity)` and `mergedStrategies` emits one card per cohort, so the
 * shape cannot arise there. The manual path had no such floor, and two
 * maturities on one card do not degrade it, they misprice it: `maturity` is
 * `Math.min` across the legs, and the countdown, `secondsToMaturity`,
 * `spreadReturnUsd` and the PnL projection all run off it.
 *
 * Shape is still not policed. Six legs, a half-open hedge, a spread with no
 * perps — all assertable. Only the date has to agree.
 */
describe('LegAssignment — one maturity per position', () => {
  const MAT = 1_800_000_000; // 2027-01-15
  const LATER = 1_820_000_000; // 2027-09-03
  const boros = makeStrategyLeg({
    kind: 'boros',
    venue: 'BINANCE',
    side: 'LONG',
    notionalToken: 300,
    marketId: 129,
    maturity: MAT,
  });
  const mountBoros = (destinations: Parameters<typeof LegAssignment>[0]['destinations']) =>
    render(
      <LegAssignment leg={boros} strategyId="ETH#HERE" destinations={destinations} onAssert={vi.fn()} />,
    );
  const dest = (borosMaturity: number | null) => [
    { id: 'ETH#OTHER#exec', label: 'ETH · OKX ⇄ Gate', borosMaturity },
  ];

  it('refuses a position running to a different date, and names the date', () => {
    mountBoros(dest(LATER));
    openDialog();
    const btn = screen.getByRole('button', { name: /ETH · OKX ⇄ Gate/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/matures 2027-09-03, not this one/);
  });

  it('a refused destination cannot be selected by clicking it anyway', () => {
    mountBoros(dest(LATER));
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: /ETH · OKX ⇄ Gate/ }));
    // Confirm only lights up once something changed; nothing did.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('offers a position running to the SAME date', () => {
    mountBoros(dest(MAT));
    openDialog();
    expect(screen.getByRole('button', { name: /ETH · OKX ⇄ Gate/ })).toBeEnabled();
  });

  it('offers a position holding no Boros leg — it has no date to disagree with', () => {
    // A perp-only card, or a spread whose Boros side is not open yet. Sending
    // the first Boros leg there is how it stops being either.
    mountBoros(dest(null));
    openDialog();
    expect(screen.getByRole('button', { name: /ETH · OKX ⇄ Gate/ })).toBeEnabled();
  });

  it('never blocks a PERP leg — a perp is perpetual and hedges every cohort', () => {
    // The solver attaches one perp across maturities on purpose; refusing the
    // same thing by hand would contradict it.
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn(), destinations: dest(LATER) });
    openDialog();
    expect(screen.getByRole('button', { name: /ETH · OKX ⇄ Gate/ })).toBeEnabled();
  });
});
