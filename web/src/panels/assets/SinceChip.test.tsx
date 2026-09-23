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
    expect(chip.firstElementChild?.tagName).toBe('svg');
    // The same 30px control as the waterfall toggle, not a small chip.
    expect(chip.className).toContain('!h-[30px]');
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
    expect(chip.className).toContain('!text-info');

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
    expect(chip.className).not.toContain('!text-info');
  });

  it('opens on click, stays open when the pointer leaves, and shuts on a click outside', async () => {
    render(
      <>
        <SinceChip base="HYPE" storedSec={undefined} defaultSec={DEFAULT_SEC} onChange={vi.fn()} />
        <p>outside</p>
      </>,
    );
    const chip = screen.getByRole('button', { name: /Since 23 Jun 2026/ });
    await userEvent.hover(chip);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await userEvent.click(chip);
    await screen.findByRole('tooltip');
    await userEvent.unhover(chip);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await userEvent.click(screen.getByText('outside'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('reads All time when defaultSinceSec is null, no position yet', () => {
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={null} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'All time' })).toBeInTheDocument();
  });

  it('shows no Default hover and no stray "All time" wording in the open popover when there is no first position', async () => {
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={null} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'All time' }));
    const card = await screen.findByRole('tooltip');
    expect(within(card).getByLabelText('Count HYPE PnL from')).toHaveValue('');
    expect(within(card).queryByText(/Default/)).toBeNull();
    expect(within(card).queryByText(/All time/)).toBeNull();
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
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

  it('ignores a date after today and keeps the stored date, no date after today', async () => {
    const onChange = vi.fn();
    render(<SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Since 1 Mar 2026/ }));
    const card = await screen.findByRole('tooltip');
    const input = within(card).getByLabelText('Count HYPE PnL from');
    fireEvent.change(input, { target: { value: '2099-01-01' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Since 1 Mar 2026/ })).toBeInTheDocument();
  });

  it('opens on Tab and Enter, moves on typing, resets on Use default, stays open on an inside click, closes on Escape, keyboard walk', async () => {
    const onChange = vi.fn();
    render(<SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={onChange} />);

    await userEvent.tab();
    const chip = screen.getByRole('button', { name: /Since 1 Mar 2026/ });
    expect(chip).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    const card = await screen.findByRole('tooltip');

    await userEvent.tab();
    const input = within(card).getByLabelText('Count HYPE PnL from');
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: '2026-07-01' } });
    expect(onChange).toHaveBeenCalledWith(Math.floor(new Date('2026-07-01T00:00').getTime() / 1000));

    await userEvent.tab();
    await userEvent.tab();
    const useDefault = within(card).getByRole('button', { name: 'Use default' });
    expect(useDefault).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    fireEvent.click(within(card).getByText('Count HYPE PnL from'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
