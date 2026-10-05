/**
 * The Accounts card: the verdict, then every account in one row format —
 * available / balance (a Boros account in its own coin, dollars under it),
 * IM used and MM used.
 */
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetBorosMargin } from '../../api/types';
import { accountBodies, baseHandlers } from '../../test/fixtures';
import { env, server } from '../../test/server';
import { renderWithClient } from '../../test/utils';
import { STRATEGY_STORAGE_KEY } from '../HomeControls';
import { AccountsOverview } from './AccountsUi';

const ROOT = '0x1111111111111111111111111111111111111111';

const eth: AssetBorosMargin = {
  tokenId: 2,
  collateral: 'ETH',
  isCross: true,
  healthFactor: 2,
  availableToken: 4.81,
  equityToken: 12.58,
  availableUsd: 13_081.6,
  equityUsd: 34_239.01,
  maintMarginUsd: 14_601.18,
};

function serve(borosMargin: AssetBorosMargin[] | null) {
  localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify({ address: ROOT, walletUpgraded: true }));
  server.use(
    ...baseHandlers(),
    http.get('/api/account', () => HttpResponse.json(env(accountBodies.accountA))),
    http.get('/api/boros/margin/:address', () =>
      // null: still loading — the request never answers.
      borosMargin === null ? new Promise(() => {}) : HttpResponse.json(env({ borosMargin })),
    ),
  );
}

afterEach(() => localStorage.clear());

describe('AccountsOverview', () => {
  it('lists every account in one format, a Boros account in its own coin first', async () => {
    serve([eth]);
    renderWithClient(<AccountsOverview />);
    const card = await screen.findByRole('region', { name: 'Accounts' });
    expect(await within(card).findByText('All accounts healthy')).toBeInTheDocument();
    expect(within(card).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Account',
      'Available / Balance',
      'IM used',
      'MM used',
    ]);
    const row = (await within(card).findByText('ETH cross')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('4.81 ETH / 12.58 ETH');
    expect(row).toHaveTextContent('$13,081.60 / $34,239.01');
    // (34,239.01 − 13,081.60) / 34,239.01 = 62% held; 14,601.18 / 34,239.01 = 43%.
    expect(row).toHaveTextContent('62%');
    expect(row).toHaveTextContent('43%');
    expect(within(card).getByText('Gate CrossEx')).toBeInTheDocument();
    // No health factor anywhere: every account reads on the same 100% scale.
    expect(card.textContent).not.toMatch(/health factor|Health \d/i);
  });

  it('holds a loading row while the Boros accounts are on their way', async () => {
    serve(null);
    renderWithClient(<AccountsOverview />);
    const card = await screen.findByRole('region', { name: 'Accounts' });
    expect(within(card).getByText('Boros')).toBeInTheDocument();
    expect(card.querySelector('.skeleton, [class*="animate-pulse"]')).not.toBeNull();
  });
});
