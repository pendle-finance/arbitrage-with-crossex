/** The membership editor: what a position's legs look like on a card, and what
 * each control asserts. Prop-driven — no query client needed. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StrategyLeg } from '../api/types';
import { makeStrategyLeg, makeStrategyRollup } from '../test/fixtures';
import { LegMembership, SplitChip, legRefOf, type LegAssertion } from './PartitionEditor';

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

/** The control as the card mounts it: inside one leg's expanded row. */
const mount = (
  venue: string,
  kind: 'perp' | 'boros',
  props: Partial<Parameters<typeof LegMembership>[0]> = {},
) => render(<LegMembership s={shared()} leg={legOf(venue, kind)} {...props} />);

const pick = (venue: string, kind: 'perp' | 'boros', value: string) =>
  fireEvent.change(screen.getByLabelText(`Where the ${venue} ${kind} leg belongs`), {
    target: { value },
  });

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

describe('LegMembership', () => {
  it('is read-only with no handler wired', () => {
    const { container } = render(<LegMembership s={shared()} leg={legOf('BINANCE', 'perp')} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('asks the one question, on the leg it is about', () => {
    mount('HYPERLIQUID', 'perp', { onAssert: vi.fn() });
    expect(screen.getByLabelText('Where the HYPERLIQUID perp leg belongs')).toBeInTheDocument();
    // The table row already names the leg and its size; only the venue WHOLE
    // is missing, and only when the leg is shared.
    expect(screen.getByText(/of.*500.*on the venue/)).toBeInTheDocument();
  });

  it('says nothing about the venue whole for a leg owned outright', () => {
    mount('BINANCE', 'perp', { onAssert: vi.fn() });
    expect(screen.queryByText(/on the venue/)).not.toBeInTheDocument();
  });

  it('claims the leg for this position without naming a size', () => {
    // The commonest assertion: whose it is, not how much. A size here would be
    // a number the user did not choose.
    const onAssert = vi.fn<(a: LegAssertion) => void>();
    mount('HYPERLIQUID', 'perp', { onAssert });
    pick('HYPERLIQUID', 'perp', '<here>');
    expect(onAssert).toHaveBeenCalledWith({
      mode: 'assign',
      leg: { kind: 'perp', symbol: HL_PERP },
      to: 'ETH#BINANCE-HYPERLIQUID#exec',
    });
    expect(onAssert.mock.calls[0][0]).not.toHaveProperty('qty');
  });

  it('MOVES the leg by naming another card — the correction the buttons could not express', () => {
    const onAssert = vi.fn<(a: LegAssertion) => void>();
    mount('BINANCE', 'boros', {
      onAssert,
      destinations: [{ id: 'ETH#GATE-HYPERLIQUID#exec', label: 'long Gate / short Hyperliquid' }],
    });
    pick('BINANCE', 'boros', 'ETH#GATE-HYPERLIQUID#exec');
    expect(onAssert).toHaveBeenCalledWith({
      mode: 'assign',
      leg: { kind: 'boros', marketId: 129 },
      to: 'ETH#GATE-HYPERLIQUID#exec',
    });
  });

  it('orphans a leg, and hands one back to the solver', () => {
    const onAssert = vi.fn<(a: LegAssertion) => void>();
    mount('BINANCE', 'perp', { onAssert });
    pick('BINANCE', 'perp', '<nowhere>');
    expect(onAssert).toHaveBeenCalledWith({ mode: 'orphan', leg: { kind: 'perp', symbol: BIN_PERP } });
    pick('BINANCE', 'perp', '<auto>');
    expect(onAssert).toHaveBeenLastCalledWith({ mode: 'auto', leg: { kind: 'perp', symbol: BIN_PERP } });
  });

  it('states a partial size only when asked for one', () => {
    const onAssert = vi.fn<(a: LegAssertion) => void>();
    mount('HYPERLIQUID', 'perp', { onAssert });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Set how much of the HYPERLIQUID perp leg this position holds',
      }),
    );
    fireEvent.change(screen.getByLabelText('HYPERLIQUID perp size for this position'), {
      target: { value: '175' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set size' }));
    expect(onAssert).toHaveBeenCalledWith({
      mode: 'assign',
      leg: { kind: 'perp', symbol: HL_PERP },
      to: 'ETH#BINANCE-HYPERLIQUID#exec',
      qty: 175,
    });
  });

  it('labels the size in the unit THAT LEG is counted in, not the card\'s coin', () => {
    // A Boros position is sized in the collateral it is margined in, which is
    // routinely a different token than the coin the card is named after. On an
    // ETH card a USDT-collateral Boros leg offered to hold "300 ETH" when the
    // figure the venue reported was 300 USDT.
    const s = shared({
      base: 'ETH',
      legs: [
        makeStrategyLeg({
          kind: 'boros',
          venue: 'BINANCE',
          side: 'LONG',
          notionalToken: 300,
          share: 0.5,
          marketId: 129,
          collateral: 'USDT',
        }),
      ],
    });
    render(<LegMembership s={s} leg={s.legs[0]} onAssert={vi.fn()} />);
    // The shared-leg line reads the same unit…
    expect(screen.getByText(/300 USDT of 600 USDT on the venue/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Set how much of the BINANCE boros leg this position holds',
      }),
    );
    // …and so does the size editor beside the input.
    const label = screen.getByLabelText('BINANCE boros size for this position').parentElement!;
    expect(label).toHaveTextContent(/USDT$/);
    expect(label).not.toHaveTextContent(/ETH/);
  });

  it('says no unit at all rather than the wrong one when the venue did not report it', () => {
    const s = shared({
      base: 'ETH',
      legs: [
        makeStrategyLeg({
          kind: 'boros',
          venue: 'BINANCE',
          side: 'LONG',
          notionalToken: 300,
          share: 1,
          marketId: 129,
          collateral: undefined,
        }),
      ],
    });
    render(<LegMembership s={s} leg={s.legs[0]} onAssert={vi.fn()} />);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Set how much of the BINANCE boros leg this position holds',
      }),
    );
    const label = screen.getByLabelText('BINANCE boros size for this position').parentElement!;
    expect(label).toHaveTextContent('This position holds');
    expect(label).not.toHaveTextContent(/ETH/);
  });

  it('refuses a leg the payload cannot name', () => {
    const { container } = render(
      <LegMembership
        s={shared()}
        leg={makeStrategyLeg({ kind: 'perp', venue: 'X', side: 'LONG', symbol: undefined })}
        onAssert={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the undo for an orphaned leg', () => {
  /**
   * There is no orphan block. Every undo reached through this picker, which is
   * the point: an orphaned Boros leg still has a card, so it still has a row,
   * so it still has this control — offering the solver AND both positions.
   * (An orphaned perp becomes unhedged size, and UnhedgedResidualBox carries
   * that one.)
   */
  it('is the ordinary picker, on the leg\'s own row', () => {
    const onAssert = vi.fn<(a: LegAssertion) => void>();
    const s = shared();
    const boros = s.legs.find((l) => l.kind === 'boros') as StrategyLeg;
    render(<LegMembership s={s} leg={boros} onAssert={onAssert} />);
    fireEvent.change(screen.getByLabelText(/Where the .* boros leg belongs/), {
      target: { value: '<auto>' },
    });
    expect(onAssert).toHaveBeenCalledWith({ mode: 'auto', leg: legRefOf(boros) });
  });
});
