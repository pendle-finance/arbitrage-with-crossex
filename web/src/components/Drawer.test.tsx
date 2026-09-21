import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Drawer } from './Drawer';
import { Modal } from './Modal';

function SettingsWithGuide() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  return (
    <>
      <Drawer open={isSettingsOpen} title="Settings" onClose={() => setIsSettingsOpen(false)}>
        <button type="button" className="btn-link" onClick={() => setIsGuideOpen(true)}>
          How to make a key
        </button>
      </Drawer>
      {isGuideOpen && (
        <Modal title="User guide" onClose={() => setIsGuideOpen(false)}>
          <a href="#make-a-key">Make a key</a>
          <a href="#fund">Fund CrossEx</a>
        </Modal>
      )}
    </>
  );
}

const guide = () => screen.getByRole('link', { name: 'Make a key' }).closest('[role="dialog"]') as HTMLElement;

async function openGuide() {
  const user = userEvent.setup();
  render(<SettingsWithGuide />);
  await user.click(screen.getByRole('button', { name: 'How to make a key' }));
  await waitFor(() => expect(within(guide()).getByRole('button', { name: 'close' })).toHaveFocus());
  return user;
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Drawer with the guide open over it', () => {
  it('Escape closes only the guide, and focus returns into the drawer', async () => {
    const user = await openGuide();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('link', { name: 'Make a key' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'How to make a key' })).toHaveFocus();
  });

  it('Tab stays in the guide while it is open', async () => {
    const user = await openGuide();
    const close = within(guide()).getByRole('button', { name: 'close' });

    await user.tab();
    expect(screen.getByRole('link', { name: 'Make a key' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Fund CrossEx' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('link', { name: 'Fund CrossEx' })).toHaveFocus();
  });

  it('Escape closes the drawer once the guide is gone', async () => {
    const user = await openGuide();
    await user.keyboard('{Escape}');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });
});
