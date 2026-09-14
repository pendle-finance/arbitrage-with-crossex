import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrossexAccount, PositionsResponse, RebalanceView, TransferView } from '../api/types';
import {
  accountBodies,
  accountHandler,
  REBALANCE_NOW,
  rebalanceHandler,
  rebalanceViews,
  transferHandler,
  transferViews,
} from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { BalancesPanel } from './BalancesPanel';

interface TabState {
  name: string;
  rebalance: RebalanceView;
  transfer: TransferView;
  account: CrossexAccount;
}

const NO_POSITIONS: PositionsResponse = { positions: [], exposure: [] };
const NO_SPOT_READ = 'Add Spot read permission to see spot balances.';

const ACCOUNT_A: TabState = {
  name: 'accountA',
  rebalance: rebalanceViews.accountA,
  transfer: transferViews.accountB,
  account: accountBodies.accountA,
};

const ACCOUNT_B: TabState = {
  name: 'accountB',
  rebalance: rebalanceViews.accountB,
  transfer: transferViews.accountB,
  account: accountBodies.accountB,
};

const LEFTOVER: TabState = {
  name: 'leftover after abandon',
  rebalance: rebalanceViews.accountAAbandoned,
  transfer: transferViews.noSpot,
  account: accountBodies.accountARound3,
};

const ACCOUNT_OF: Record<keyof typeof rebalanceViews, CrossexAccount> = {
  accountA: accountBodies.accountA,
  accountARunning: accountBodies.accountARound3,
  accountAHalted: accountBodies.accountARound3,
  accountAAbandoned: accountBodies.accountARound3,
  accountABlocked: accountBodies.accountA,
  accountB: accountBodies.accountB,
  exampleC: accountBodies.exampleC,
  exampleD: accountBodies.exampleD,
  exampleE: accountBodies.exampleE,
  balancedDone: accountBodies.accountB,
  oldDone: accountBodies.accountB,
  exampleERunning: accountBodies.exampleE,
  exampleEAbandoned: accountBodies.exampleE,
  exampleDRunningConvert: accountBodies.exampleD,
  exampleDHaltedConvert: accountBodies.exampleD,
  mixDone: accountBodies.exampleD,
  haltedInside: accountBodies.accountARound3,
  convertDone: accountBodies.accountA,
  balancedNoJob: accountBodies.accountB,
  spotClosed: accountBodies.accountA,
  underMinimum: accountBodies.accountA,
  borrowUnderOne: accountBodies.accountB,
  accountADone: accountBodies.accountA,
};

const isRebalanceName = (name: string): name is keyof typeof rebalanceViews => name in rebalanceViews;

const EVERY_STATE: TabState[] = [
  ...Object.keys(rebalanceViews)
    .filter(isRebalanceName)
    .map((name) => ({ ...ACCOUNT_B, name, rebalance: rebalanceViews[name], account: ACCOUNT_OF[name] })),
  ...Object.entries(transferViews).map(([name, transfer]) => ({ ...ACCOUNT_B, name: `transfer ${name}`, transfer })),
  LEFTOVER,
];

const region = (name: string) => screen.getByRole('region', { name });

async function show(state: TabState) {
  server.use(
    rebalanceHandler(state.rebalance),
    transferHandler(state.transfer),
    accountHandler(state.account),
    http.get('/api/positions', () => HttpResponse.json(env(NO_POSITIONS))),
  );
  const shown = renderWithClient(<BalancesPanel />);
  await screen.findByRole('region', { name: 'Rebalance' });
  await within(region('Transfer')).findByRole('radio', { name: 'Out of CrossEx' });
  await within(region('Transfer')).findByRole('radio', { name: 'Into CrossEx' });
  return shown;
}

function assetRows(): Record<string, string>[] {
  const table = within(region('Assets')).getByRole('table');
  const headers = Array.from(table.querySelectorAll('th'), (th) => th.textContent ?? '');
  return Array.from(table.querySelectorAll('tbody tr'), (tr) =>
    Object.fromEntries(Array.from(tr.querySelectorAll('td'), (td, i) => [headers[i], td.textContent ?? ''])),
  );
}

async function renderedTexts() {
  const user = userEvent.setup();
  const texts: { name: string; text: string }[] = [];
  for (const state of EVERY_STATE) {
    const shown = await show(state);
    const steps = within(region('Rebalance')).queryByRole('button', { name: /^Show the / });
    if (steps) await user.click(steps);
    texts.push({ name: state.name, text: document.body.textContent ?? '' });
    shown.unmount();
  }
  return texts;
}

describe('BalancesPanel layout', () => {
  it('cards in order', async () => {
    await show(ACCOUNT_A);
    expect(screen.getAllByRole('region').map((section) => section.getAttribute('aria-label'))).toEqual([
      'Rebalance',
      'Transfer',
      'Assets',
    ]);
    const margin = screen.getByRole('img', { name: 'Margin usage' });
    expect(margin.compareDocumentPosition(region('Rebalance')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('two info marks', async () => {
    for (const state of [ACCOUNT_A, LEFTOVER]) {
      const shown = await show(state);
      const marks = Array.from(document.querySelectorAll('span[aria-hidden="true"]')).filter(
        (mark) => mark.textContent === 'i',
      );
      expect(marks.map((mark) => mark.closest('[role="button"]')?.firstChild?.textContent), state.name).toEqual([
        'Rebalance',
        'Transfer',
      ]);
      shown.unmount();
    }
  });
});

describe('BalancesPanel copy in every state', () => {
  beforeEach(() => {
    vi.setSystemTime(REBALANCE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no em dash', async () => {
    for (const { name, text } of await renderedTexts()) expect(text, name).not.toContain('—');
  }, 60_000);

  it('no to Hyperliquid', async () => {
    for (const { name, text } of await renderedTexts()) expect(text, name).not.toMatch(/\b(to|from) Hyperliquid\b/);
  }, 60_000);
});

describe('BalancesPanel assets', () => {
  it('spot rows', async () => {
    await show(ACCOUNT_B);
    const rows = assetRows();
    expect(rows.map((row) => row.Coin)).toEqual(['USDT CROSSEX', 'USDC HYPERLIQUID', 'USDC GATE', 'Gate spot', 'USDT SPOT']);
    expect(rows[4]).toMatchObject({ Balance: '318.42', Available: '318.42' });
  });

  it('spot row has no equity', async () => {
    await show(ACCOUNT_B);
    expect(assetRows()[4]).toMatchObject({ Coin: 'USDT SPOT', Equity: '', uPnL: '' });
  });

  it('spot balance adds locked', async () => {
    await show({
      ...ACCOUNT_B,
      transfer: {
        ...transferViews.accountB,
        spot: [
          { coin: 'USDT', available: 300, locked: 18.42 },
          { coin: 'USDC', available: 0, locked: 5 },
        ],
      },
    });
    expect(assetRows().slice(4)).toEqual([
      { Coin: 'USDT SPOT', Equity: '', Balance: '318.42', Available: '300.00', uPnL: '' },
      { Coin: 'USDC SPOT', Equity: '', Balance: '5.00', Available: '0.00', uPnL: '' },
    ]);
  });

  it('assets no spot read', async () => {
    await show(LEFTOVER);
    const rows = assetRows();
    const group = rows.findIndex((row) => row.Coin === 'Gate spot');
    expect(group).toBe(rows.length - 2);
    expect(rows[group + 1].Coin.startsWith(NO_SPOT_READ)).toBe(true);
    expect(within(region('Assets')).getByText(NO_SPOT_READ)).toBeInTheDocument();
  });
});

describe('BalancesPanel transfer pick', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spot link picks USDT wallet', async () => {
    const user = userEvent.setup();
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    await show(ACCOUNT_B);
    const transfer = region('Transfer');
    const radio = (name: string) => within(transfer).getByRole('radio', { name });
    const link = await within(region('Rebalance')).findByRole('button', { name: 'Transfer ▸' });

    await user.click(radio('USDC · Hyperliquid'));
    await user.click(link);
    expect(radio('Into CrossEx')).toBeChecked();
    expect(radio('USDT · CrossEx')).toBeChecked();
    expect(scroll.mock.contexts.at(-1)).toContainElement(transfer);

    await user.click(radio('Out of CrossEx'));
    await user.click(radio('USDC · Hyperliquid'));
    await user.click(link);
    expect(radio('Into CrossEx')).toBeChecked();
    expect(radio('USDT · CrossEx')).toBeChecked();
  });

  it('leftover link picks target wallet', async () => {
    const user = userEvent.setup();
    await show(LEFTOVER);
    const transfer = region('Transfer');
    await user.click(await within(region('Rebalance')).findByRole('button', { name: 'Transfer ▸' }));
    expect(within(transfer).getByRole('radio', { name: 'Into CrossEx' })).toBeChecked();
    expect(within(transfer).getByRole('radio', { name: 'USDC · Hyperliquid' })).toBeChecked();
  });

  it('a USDC line picks the Hyperliquid wallet', async () => {
    const user = userEvent.setup();
    await show({ ...ACCOUNT_B, transfer: transferViews.spotBoth });
    const transfer = region('Transfer');
    const links = within(region('Rebalance')).getAllByRole('button', { name: 'Transfer ▸' });
    expect(links).toHaveLength(2);

    await user.click(links[1]);
    expect(within(transfer).getByRole('radio', { name: 'Into CrossEx' })).toBeChecked();
    expect(within(transfer).getByRole('radio', { name: 'USDC · Hyperliquid' })).toBeChecked();
  });

  it('a toward USDT leftover picks USDC · Gate', async () => {
    const user = userEvent.setup();
    await show({
      name: 'exampleEAbandoned',
      rebalance: rebalanceViews.exampleEAbandoned,
      transfer: transferViews.noSpot,
      account: accountBodies.exampleE,
    });
    const transfer = region('Transfer');
    await user.click(await within(region('Rebalance')).findByRole('button', { name: 'Transfer ▸' }));
    expect(within(transfer).getByRole('radio', { name: 'Into CrossEx' })).toBeChecked();
    expect(within(transfer).getByRole('radio', { name: 'USDC · Gate' })).toBeChecked();
  });
});

describe('BalancesPanel spot group', () => {
  it('all spot coins at 0 hide the group', async () => {
    await show({ ...ACCOUNT_B, transfer: transferViews.spotZero });
    expect(within(region('Assets')).queryByRole('button', { name: 'Gate spot' })).toBeNull();
  });

  it('no CrossEx assets and no Spot read', async () => {
    await show({ ...ACCOUNT_B, transfer: transferViews.noSpot, account: accountBodies.noAssets });
    const assets = region('Assets');
    expect(within(assets).getByRole('button', { name: 'Gate spot' })).toBeInTheDocument();
    expect(within(assets).getByText(NO_SPOT_READ)).toBeInTheDocument();
    expect(within(assets).queryByText('No non-zero balances')).toBeNull();
  });
});
