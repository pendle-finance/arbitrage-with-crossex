import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Modal } from './Modal';
import { UnderlineTabs } from './UnderlineTabs';

const OPTIONS = [
  { value: 'move', label: 'Move cash' },
  { value: 'realize', label: 'Realize uPnL' },
  { value: 'delever', label: 'Delever' },
] as const;

type Tab = (typeof OPTIONS)[number]['value'];

function Tabs({ start = 'move' }: { start?: Tab }) {
  const [tab, setTab] = useState<Tab>(start);
  return <UnderlineTabs<Tab> ariaLabel="Tabs" look="underline" value={tab} onChange={setTab} options={OPTIONS} />;
}

describe('UnderlineTabs', () => {
  it('arrow keys move between tabs and pick them', async () => {
    const user = userEvent.setup();
    render(<Tabs />);
    await user.click(screen.getByRole('radio', { name: 'Move cash' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Realize uPnL' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Realize uPnL' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Delever' })).toHaveAttribute('aria-checked', 'true');
  });

  it('only the picked tab is in the tab order', () => {
    render(<Tabs start="realize" />);
    expect(screen.getByRole('radio', { name: 'Realize uPnL' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Move cash' })).toHaveAttribute('tabindex', '-1');
  });

  it('a dialog with tabs in its title focuses the picked tab on open', async () => {
    render(
      <Modal title={<Tabs start="delever" />} onClose={() => {}}>
        <button type="button">Body</button>
      </Modal>,
    );
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Delever' })).toHaveFocus());
  });
});
