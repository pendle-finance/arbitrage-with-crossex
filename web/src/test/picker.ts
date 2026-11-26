import { screen, waitFor, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { expect } from 'vitest';

type User = ReturnType<typeof userEvent.setup>;

async function openList(user: User, label: string): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: label }));
  return screen.findByRole('listbox', { name: label });
}

export async function optionLabels(user: User, label: string): Promise<string[]> {
  const list = await openList(user, label);
  const labels = within(list)
    .queryAllByRole('option')
    .map((option) => option.textContent ?? '');
  await user.keyboard('{Escape}');
  return labels;
}

export async function waitForOptions(user: User, label: string): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
  const list = await openList(user, label);
  await waitFor(() => expect(within(list).queryAllByRole('option').length).toBeGreaterThan(0));
  await user.keyboard('{Escape}');
}

export async function pickOption(user: User, label: string, key: string): Promise<void> {
  const list = await openList(user, label);
  let option: HTMLElement | null = null;
  await waitFor(() => {
    option = list.querySelector<HTMLElement>(`[data-value="${key}"]`);
    expect(option).not.toBeNull();
  });
  await user.click(option!);
}
