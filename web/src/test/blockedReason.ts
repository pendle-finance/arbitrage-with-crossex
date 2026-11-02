import { screen, waitFor } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { expect } from 'vitest';

export async function blockedReason(user: ReturnType<typeof userEvent.setup>, button: HTMLElement): Promise<string> {
  expect(button).not.toHaveAttribute('title');
  await user.hover(button);
  const text = (await screen.findByRole('tooltip')).textContent ?? '';
  await user.unhover(button);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  return text;
}

export async function blockedReasons(user: ReturnType<typeof userEvent.setup>, buttons: HTMLElement[]): Promise<string[]> {
  const out: string[] = [];
  for (const b of buttons) out.push(await blockedReason(user, b));
  return out;
}
