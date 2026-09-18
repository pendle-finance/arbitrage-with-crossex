import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SinceChip } from './SinceChip';

const DEFAULT_SEC = Date.UTC(2026, 5, 23, 12, 0, 0) / 1000;
const MARCH_SEC = Date.UTC(2026, 2, 1, 12, 0, 0) / 1000;

describe('SinceChip', () => {
  it('reads Since 23 Jun 2026 with the calendar icon on its left, default date', () => {
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={DEFAULT_SEC} onChange={vi.fn()} />);
    const chip = screen.getByRole('button', { name: /Since 23 Jun 2026/ });
    const pill = chip.querySelector('.chip');
    expect(pill?.firstElementChild?.tagName).toBe('svg');
  });

  it('shows Count HYPE PnL from, a date input and Default 23 Jun 2026 with no Use default, popover at default', async () => {
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={DEFAULT_SEC} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Since 23 Jun 2026/ }));
    const card = await screen.findByRole('tooltip');
    expect(within(card).getByLabelText('Count HYPE PnL from')).toHaveValue('2026-06-23');
    expect(within(card).getByText('Default 23 Jun 2026')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Use default' })).toBeNull();
  });

  it('reads Your first CrossEx position on hover, default hover', async () => {
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={DEFAULT_SEC} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Since 23 Jun 2026/ }));
    await screen.findByRole('tooltip');
    await userEvent.hover(screen.getByRole('button', { name: 'Default 23 Jun 2026' }));
    expect(await screen.findByText('Your first CrossEx position')).toBeInTheDocument();
  });

  it('turns the chip text blue and shows Use default, moved date', async () => {
    render(<SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={vi.fn()} />);
    const chip = screen.getByRole('button', { name: /Since 1 Mar 2026/ });
    const pill = chip.querySelector('.chip');
    expect(pill?.className).toContain('text-sky-400');

    await userEvent.click(chip);
    const card = await screen.findByRole('tooltip');
    expect(within(card).getByRole('button', { name: 'Use default' })).toBeInTheDocument();
  });

  it('removes the stored date and reads Since 23 Jun 2026 again, use default resets', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Since 1 Mar 2026/ }));
    const card = await screen.findByRole('tooltip');
    await userEvent.click(within(card).getByRole('button', { name: 'Use default' }));
    expect(onChange).toHaveBeenCalledWith(undefined);

    rerender(<SinceChip base="HYPE" storedSec={undefined} defaultSec={DEFAULT_SEC} onChange={onChange} />);
    const chip = screen.getByRole('button', { name: /Since 23 Jun 2026/ });
    expect(chip.querySelector('.chip')?.className).not.toContain('text-sky-400');
  });

  it('reads All time when defaultSinceSec is null, no position yet', () => {
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={null} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'All time' })).toBeInTheDocument();
  });

  it('shows no Default hover and no stray "All time" wording when there is no first position', () => {
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={null} onChange={vi.fn()} />);
    expect(screen.queryByText(/Default/)).toBeNull();
    expect(screen.queryByText('Your first CrossEx position')).toBeNull();
  });

  it('keeps the default start, not local midnight, when the default day is picked again', async () => {
    const onChange = vi.fn();
    render(<SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Since 1 Mar 2026/ }));
    const card = await screen.findByRole('tooltip');
    const input = within(card).getByLabelText('Count HYPE PnL from');
    fireEvent.change(input, { target: { value: '2026-06-23' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('does not reset the date while one part of the input is mid-edit', async () => {
    const onChange = vi.fn();
    render(<SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Since 1 Mar 2026/ }));
    const card = await screen.findByRole('tooltip');
    const input = within(card).getByLabelText('Count HYPE PnL from');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
