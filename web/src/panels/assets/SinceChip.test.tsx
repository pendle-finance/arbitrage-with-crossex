import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_TIME_SEC, SinceChip } from './SinceChip';

const DEFAULT_SEC = Date.UTC(2026, 5, 23, 12, 0, 0) / 1000;
const MARCH_SEC = Date.UTC(2026, 2, 1, 12, 0, 0) / 1000;

const dateField = () => screen.getByLabelText('Count HYPE PnL from');

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLInputElement.prototype as { showPicker?: unknown }).showPicker;
});

describe('SinceChip', () => {
  it('reads Since 23 Jun 2026 with the calendar icon on its left, default date', () => {
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={DEFAULT_SEC} onChange={vi.fn()} />);
    const chip = screen.getByRole('button', { name: /Since 23 Jun 2026/ });
    expect(chip.firstElementChild?.tagName).toBe('svg');
    // The same 30px control as the waterfall toggle, not a small chip.
    expect(chip.className).toContain('!h-[30px]');
    expect(dateField()).toHaveValue('2026-06-23');
  });

  it('opens the date picker in one click', async () => {
    const showPicker = vi.fn();
    (HTMLInputElement.prototype as { showPicker?: unknown }).showPicker = showPicker;
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={DEFAULT_SEC} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Since 23 Jun 2026/ }));
    expect(showPicker).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('focuses the field when the browser has no showPicker', async () => {
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={DEFAULT_SEC} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Since 23 Jun 2026/ }));
    expect(dateField()).toHaveFocus();
  });

  it('saves a picked date', () => {
    const onChange = vi.fn();
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={DEFAULT_SEC} onChange={onChange} />);
    fireEvent.change(dateField(), { target: { value: '2026-07-01' } });
    expect(onChange).toHaveBeenCalledWith(Math.floor(new Date('2026-07-01T00:00').getTime() / 1000));
  });

  it('offers All time from the arrow at the default date', async () => {
    const onChange = vi.fn();
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={DEFAULT_SEC} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Date options' }));
    const card = await screen.findByRole('tooltip');
    expect(within(card).queryByRole('button', { name: /Use default/ })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'All time' }));
    expect(onChange).toHaveBeenCalledWith(ALL_TIME_SEC);
  });

  it('reads All time for a stored 0, and offers Use default', async () => {
    const onChange = vi.fn();
    render(<SinceChip base="HYPE" storedSec={ALL_TIME_SEC} defaultSec={DEFAULT_SEC} onChange={onChange} />);
    const chip = screen.getByRole('button', { name: /^All time$/ });
    expect(chip.className).toContain('!text-info');
    expect(dateField()).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Date options' }));
    const card = await screen.findByRole('tooltip');
    expect(within(card).queryByRole('button', { name: 'All time' })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Use default (first position, 23 Jun 2026)' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('turns the chip blue and offers both resets on a moved date', async () => {
    render(<SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Since 1 Mar 2026/ }).className).toContain('!text-info');
    await userEvent.click(screen.getByRole('button', { name: 'Date options' }));
    const card = await screen.findByRole('tooltip');
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All time',
      'Use default (first position, 23 Jun 2026)',
    ]);
  });

  it('reads All time with no arrow when there is no first position yet', () => {
    render(<SinceChip base="HYPE" storedSec={undefined} defaultSec={null} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'All time' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Date options' })).toBeNull();
  });

  it('keeps the default start, not local midnight, when the default day is picked again', () => {
    const onChange = vi.fn();
    render(<SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={onChange} />);
    fireEvent.change(dateField(), { target: { value: '2026-06-23' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('does not reset the date while one part of the input is mid-edit', () => {
    const onChange = vi.fn();
    render(<SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={onChange} />);
    fireEvent.change(dateField(), { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores a date after today and keeps the stored date', () => {
    const onChange = vi.fn();
    render(<SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={onChange} />);
    fireEvent.change(dateField(), { target: { value: '2099-01-01' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Since 1 Mar 2026/ })).toBeInTheDocument();
  });

  it('keyboard: Enter on the chip opens the picker, the arrow menu closes on Escape', async () => {
    const showPicker = vi.fn();
    (HTMLInputElement.prototype as { showPicker?: unknown }).showPicker = showPicker;
    render(<SinceChip base="HYPE" storedSec={MARCH_SEC} defaultSec={DEFAULT_SEC} onChange={vi.fn()} />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: /Since 1 Mar 2026/ })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(showPicker).toHaveBeenCalledTimes(1);

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Date options' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('tooltip');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
