import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HoverCard } from './HoverCard';

function renderCard(children: ReactNode) {
  render(
    <>
      <button type="button">Before</button>
      <HoverCard label="How">{children}</HoverCard>
      <button type="button">After</button>
    </>,
  );
  return screen.getByRole('button', { name: 'How' });
}

const twoLinks = (
  <>
    <a href="https://example.com/keys">API Management</a>
    <a href="https://example.com">Gate</a>
  </>
);

describe('HoverCard', () => {
  it('enter moves focus into a card with a link', async () => {
    const trigger = renderCard(twoLinks);
    trigger.focus();
    await userEvent.keyboard('{Enter}');

    const card = await screen.findByRole('tooltip');
    expect(within(card).getByRole('link', { name: 'API Management' })).toHaveFocus();
  });

  it('tab past the last link closes the card and returns to the trigger', async () => {
    const trigger = renderCard(twoLinks);
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const card = await screen.findByRole('tooltip');

    await userEvent.tab();
    expect(within(card).getByRole('link', { name: 'Gate' })).toHaveFocus();

    await userEvent.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('shift tab from the first link closes the card and returns to the trigger', async () => {
    const trigger = renderCard(twoLinks);
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('tooltip');

    await userEvent.tab({ shift: true });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).toHaveFocus();

    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
  });

  it('escape returns focus to the trigger', async () => {
    const trigger = renderCard(twoLinks);
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const card = await screen.findByRole('tooltip');
    expect(within(card).getByRole('link', { name: 'API Management' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('mouse open keeps focus where it was', async () => {
    const trigger = renderCard(twoLinks);
    const before = screen.getByRole('button', { name: 'Before' });
    before.focus();

    await userEvent.hover(trigger);
    await screen.findByRole('tooltip');
    expect(before).toHaveFocus();
  });

  it('enter on a focused card button presses it', async () => {
    const onPress = vi.fn();
    const trigger = renderCard(
      <button type="button" onClick={onPress}>
        Rebalance on Balances ▸
      </button>,
    );
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const card = await screen.findByRole('tooltip');
    expect(within(card).getByRole('button', { name: 'Rebalance on Balances ▸' })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('a link inside the card opens', async () => {
    const trigger = renderCard(
      <a href="https://example.com" target="_blank" rel="noreferrer">
        API Management
      </a>,
    );
    expect(fireEvent.click(trigger)).toBe(false);
    const card = await screen.findByRole('tooltip');

    expect(fireEvent.click(within(card).getByRole('link', { name: 'API Management' }))).toBe(true);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a card with no link keeps focus on the trigger', async () => {
    const trigger = renderCard(<p>Fee is flat.</p>);
    trigger.focus();
    await userEvent.keyboard('{Enter}');

    await screen.findByRole('tooltip');
    expect(trigger).toHaveFocus();
  });
});
