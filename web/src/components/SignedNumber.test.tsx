/** The signed-value cell: colour and sign, and what happens to a number that
 * rounds away to nothing. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SignedNumber } from './SignedNumber';
import { fmtUsd } from '../lib/fmt';

afterEach(cleanup);

const cell = () => screen.getByText((_, el) => el?.tagName === 'SPAN' && el.className.includes('num'));

describe('SignedNumber', () => {
  it('marks a real gain green with a +', () => {
    render(<SignedNumber value={1.23} format={(n) => fmtUsd(n)} />);
    expect(cell()).toHaveTextContent('+$1.23');
    expect(cell().className).toContain('emerald');
  });

  it('marks a real loss red with a -', () => {
    render(<SignedNumber value={-1.23} format={(n) => fmtUsd(n)} />);
    expect(cell()).toHaveTextContent('-$1.23');
    expect(cell().className).toContain('rose');
  });

  it('does NOT show a loss that rounds away to nothing', () => {
    // -0.004 is genuinely negative but renders "$0.00" at 2dp. A minus sign and
    // a red cell for a loss of nothing reads as alarming on a page of live
    // positions — it should look exactly like an exact zero.
    render(<SignedNumber value={-0.004} format={(n) => fmtUsd(n)} />);
    expect(cell()).toHaveTextContent('$0.00');
    expect(cell().textContent).not.toContain('-');
    expect(cell().className).not.toContain('rose');
    expect(cell().className).toContain('ink');
  });

  it('does not decorate a gain that rounds away either', () => {
    render(<SignedNumber value={0.004} format={(n) => fmtUsd(n)} />);
    expect(cell().textContent).not.toContain('+');
    expect(cell().className).not.toContain('emerald');
  });

  it('still dims an exact zero', () => {
    render(<SignedNumber value={0} format={(n) => fmtUsd(n)} />);
    expect(cell()).toHaveTextContent('$0.00');
    expect(cell().className).toContain('ink');
  });

  it('respects a formatter that keeps more precision', () => {
    // The formatter decides what "zero" looks like: at 4dp this value has a
    // non-zero digit, so it is a real loss and must stay red and signed.
    render(<SignedNumber value={-0.004} format={(n) => fmtUsd(n, 4)} />);
    expect(cell()).toHaveTextContent('-$0.0040');
    expect(cell().className).toContain('rose');
  });

  it('renders a dash for a non-finite value', () => {
    render(<SignedNumber value={Number.NaN} />);
    expect(cell()).toHaveTextContent('—');
  });
});

describe('fmtUsd precision floor', () => {
  it('never rounds a real amount away to "$0"', async () => {
    const { fmtUsd } = await import('../lib/fmt');
    // The reported bug: dp=0 is a tidiness preference for wide columns, not a
    // licence to print a balance the user holds as nothing.
    expect(fmtUsd(0.07, 0)).toBe('$0.07');
    expect(fmtUsd(0.2, 0)).toBe('$0.20');
    expect(fmtUsd(-0.07, 0)).toBe('-$0.07');
    // Large values still honour the requested precision.
    expect(fmtUsd(1234.5, 0)).toBe('$1,235');
    // ...and above the rounding boundary dp=0 is respected as asked.
    expect(fmtUsd(0.7, 0)).toBe('$1');
    // An exact zero is the one thing that may print as "$0".
    expect(fmtUsd(0, 0)).toBe('$0');
  });
});
