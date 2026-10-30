/** A locked rate reads as what the position pays or receives, never a bare sign. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FixedRate } from './FixedRate';

afterEach(cleanup);

describe('FixedRate', () => {
  it('says pay for a long rate, signed −', () => {
    render(<FixedRate apr={-0.0874} />);
    expect(screen.getByText('pay 8.74%')).toBeInTheDocument();
  });

  it('says receive for a short rate, signed +', () => {
    render(<FixedRate apr={0.0712} />);
    expect(screen.getByText('receive 7.12%')).toBeInTheDocument();
  });
});
