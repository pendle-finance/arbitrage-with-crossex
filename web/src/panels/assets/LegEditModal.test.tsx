/**
 * LegEditModal — the save rules behind the per-leg "edit" popup: include
 * all clears the entry, a slice saves {qty, at}, and a slice the size of the
 * leg IS 'all'. The arithmetic behind the preview is assetModel's keptSlice
 * (tested there); this pins what the popup HANDS BACK.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LegEditModal } from './AssetCard';

const base = {
  exKey: 'perp:HL',
  label: 'Hyperliquid LONG perp',
  unit: 'ETH',
  legQty: 1000,
  entry: 1900,
  entryKind: 'price' as const,
};

describe('LegEditModal', () => {
  it('a slice at its own price saves {qty, at}; the preview shows the residual remainder', async () => {
    const onExclude = vi.fn();
    render(<LegEditModal {...base} current={undefined} onExclude={onExclude} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Exclude a portion' }));
    await userEvent.type(screen.getByLabelText('Quantity to exclude (ETH)'), '250');
    const at = screen.getByLabelText('Price the excluded slice was opened at');
    await userEvent.clear(at);
    await userEvent.type(at, '1800');
    // (1000×1900 − 250×1800) / 750 = 1,933.33
    expect(screen.getByText(/Farm keeps/)).toHaveTextContent('750 ETH at $1,933.33');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onExclude).toHaveBeenCalledWith('perp:HL', { qty: 250, at: 1800 });
  });

  it("a slice the size of the leg saves 'all'", async () => {
    const onExclude = vi.fn();
    render(<LegEditModal {...base} current={undefined} onExclude={onExclude} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Exclude a portion' }));
    await userEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByText(/whole leg is excluded/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onExclude).toHaveBeenCalledWith('perp:HL', 'all');
  });

  it('include all clears an existing exclusion', async () => {
    const onExclude = vi.fn();
    render(
      <LegEditModal {...base} current={{ qty: 250, at: 1800 }} onExclude={onExclude} onClose={() => {}} />,
    );
    // Opens on the portion it was saved with…
    expect(screen.getByRole('radio', { name: 'Exclude a portion' })).toBeChecked();
    expect(screen.getByLabelText('Quantity to exclude (ETH)')).toHaveValue('250');
    // …and "include all" hands back undefined.
    await userEvent.click(screen.getByRole('radio', { name: /Include all/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onExclude).toHaveBeenCalledWith('perp:HL', undefined);
  });

  it('a Boros leg takes the rate in percent and saves it as a fraction', async () => {
    const onExclude = vi.fn();
    render(
      <LegEditModal
        {...base}
        exKey="boros:1"
        label="Gate LONG YU"
        entry={0.08}
        entryKind="rate"
        current={undefined}
        onExclude={onExclude}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Exclude a portion' }));
    await userEvent.type(screen.getByLabelText('Quantity to exclude (ETH)'), '250');
    const at = screen.getByLabelText('Rate the excluded slice was locked at');
    expect(at).toHaveValue('8'); // defaults to the leg's own rate, shown in %
    await userEvent.clear(at);
    await userEvent.type(at, '12');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onExclude).toHaveBeenCalledWith('boros:1', { qty: 250, at: 0.12 });
  });
});
