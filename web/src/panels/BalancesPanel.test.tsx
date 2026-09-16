import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRebalance } from '../api/queries';
import type { CrossexAccount, PositionsResponse, RebalanceView, TransferView } from '../api/types';
import { FreshnessButton } from '../components/FreshnessIndicator';
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

const GATE_ERROR = { ok: false, error: { category: 'network', message: 'Gate did not answer.', retryable: true } };

function ReadRebalanceAgain() {
  const query = useRebalance();
  return (
    <button type="button" onClick={() => void query.refetch()}>
      read rebalance again
    </button>
  );
}

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
  lighterSplit: accountBodies.lighter,
  lighterAcross: accountBodies.lighter,
  lighterAcrossRunning: accountBodies.lighter,
  lighterAcrossAbandoned: accountBodies.lighter,
  lighterConvertDone: accountBodies.lighter,
  noLegs: accountBodies.lighter,
  twoBorrows: accountBodies.twoBorrows,
  oneBorrow: accountBodies.oneBorrow,
  hyperliquidFreeBorrow: accountBodies.hyperliquidFreeBorrow,
  gainOverNegativeCash: accountBodies.gainOverNegativeCash,
  interestPaidSplit: accountBodies.interestPaidSplit,
  oneRouteOnly: accountBodies.oneRouteOnly,
  hiddenRoute: accountBodies.hiddenRoute,
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
  await screen.findByRole('region', { name: 'Transfer' });
  return shown;
}

async function openRebalanceDialog(user: ReturnType<typeof userEvent.setup>) {
  const cta = within(region('Rebalance'))
    .getAllByRole('button', { name: /^Rebalance/ })
    .find((el): el is HTMLButtonElement => el.tagName === 'BUTTON');
  if (!cta) throw new Error('Rebalance CTA button not found');
  await user.click(cta);
  return screen.findByRole('dialog');
}

function assetRows(): Record<string, string>[] {
  const table = within(region('Assets')).getByRole('table');
  const headers = Array.from(table.querySelectorAll('th'), (th) => th.textContent ?? '');
  return Array.from(table.querySelectorAll('tbody tr'), (tr) =>
    Object.fromEntries(Array.from(tr.querySelectorAll('td'), (td, i) => [headers[i], td.textContent ?? ''])),
  );
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI']);

function isLeafBlock(el: Element): boolean {
  return BLOCK_TAGS.has(el.tagName) && el.querySelector('p, div, li') === null;
}

function blockTexts(root: ParentNode): string[] {
  const texts: string[] = [];
  for (const el of root.querySelectorAll('p, div, li')) {
    if (!isLeafBlock(el)) continue;
    const value = el.textContent?.trim();
    if (value) texts.push(value);
  }
  return texts;
}

function tabPanel(): HTMLElement {
  return screen.getByTestId('balances-tabpanel');
}

async function renderedTexts() {
  const texts: { name: string; text: string; blocks: string[] }[] = [];
  for (const state of EVERY_STATE) {
    const shown = await show(state);
    const root = tabPanel();
    texts.push({ name: state.name, text: root.textContent ?? '', blocks: blockTexts(root) });
    shown.unmount();
  }
  return texts;
}

const SENTENCE_END = /[.?!](?=\s|$)/g;

function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let match: RegExpExecArray | null;
  SENTENCE_END.lastIndex = 0;
  while ((match = SENTENCE_END.exec(text))) {
    sentences.push(text.slice(start, match.index + 1));
    start = match.index + 1;
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences.map((sentence) => sentence.trim()).filter(Boolean);
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

  it('assets table scrolls with the page', async () => {
    await show(ACCOUNT_B);
    expect(within(region('Assets')).getByRole('table').parentElement).toHaveClass('max-h-none');
  });

  it('margin card gets the borrow margin', async () => {
    await show(ACCOUNT_B);
    expect(screen.queryByText(/of it is for the borrow/)).toBeNull();
    cleanup();

    await show({ ...ACCOUNT_B, rebalance: rebalanceViews.twoBorrows, account: accountBodies.twoBorrows });
    expect(screen.getByText('$48.80 of it is for the borrow')).toBeInTheDocument();
  });

  it('two info marks', async () => {
    for (const state of [ACCOUNT_A, LEFTOVER]) {
      const shown = await show(state);
      const marks = Array.from(document.querySelectorAll('span[aria-hidden="true"]')).filter(
        (mark) => mark.textContent === 'i',
      );
      expect(marks.map((mark) => mark.closest('[role="button"]')?.firstChild?.textContent), state.name).toEqual([
        'Rebalance',
        'Manual Transfer',
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
    for (const { name, text } of await renderedTexts()) expect(text, name).not.toMatch(/[–—]/);

    const user = userEvent.setup();
    server.use(
      rebalanceHandler(rebalanceViews.twoBorrows),
      transferHandler(transferViews.accountB),
      accountHandler(accountBodies.twoBorrows),
      http.get('/api/positions', () => HttpResponse.json(env(NO_POSITIONS))),
    );
    const stale = renderWithClient(
      <>
        <BalancesPanel />
        <ReadRebalanceAgain />
      </>,
    );
    await screen.findByRole('region', { name: 'Rebalance' });
    server.use(http.get('/api/rebalance', () => HttpResponse.json(GATE_ERROR, { status: 500 })));
    await user.click(screen.getByRole('button', { name: 'read rebalance again' }));
    const staleChip = await screen.findByText(/^stale \d+s · retrying$/);
    expect(staleChip.textContent, 'stale · retrying').not.toMatch(/[–—]/);
    stale.unmount();

    const loading = renderWithClient(
      <FreshnessButton dataUpdatedAt={0} staleError={false} title="Refetch all panels" onRefetch={() => {}} />,
    );
    expect(screen.getByText('⟳ loading').textContent, 'before the first read').not.toMatch(/[–—]/);
    loading.unmount();

    const noFunds = await show({ ...ACCOUNT_B, account: accountBodies.noAssets });
    expect(screen.getAllByText('n/a').length).toBeGreaterThan(0);
    expect(tabPanel().textContent, 'margin card, no funds').not.toMatch(/[–—]/);
    noFunds.unmount();
  }, 60_000);

  it('no long sentence', async () => {
    for (const { name, blocks } of await renderedTexts()) {
      for (const block of blocks) {
        for (const sentence of sentencesOf(block)) {
          const words = sentence.split(/\s+/).filter(Boolean);
          expect(words.length, `${name}: "${sentence}"`).toBeLessThanOrEqual(20);
        }
      }
    }
  }, 60_000);

  it('no to Hyperliquid', async () => {
    for (const { name, text } of await renderedTexts()) expect(text, name).not.toMatch(/\b(to|from) Hyperliquid\b/);
  }, 60_000);
});

describe('block sentence check', () => {
  it('flags a long sentence split across three spans', () => {
    const words = Array.from({ length: 25 }, (_, i) => `word${i}`);
    const shown = renderWithClient(
      <p>
        <span>{`${words.slice(0, 9).join(' ')} `}</span>
        <span>{`${words.slice(9, 17).join(' ')} `}</span>
        <span>{`${words.slice(17).join(' ')}.`}</span>
      </p>,
    );
    const [block] = blockTexts(document.body);
    const sentences = sentencesOf(block);
    expect(sentences).toHaveLength(1);
    expect(sentences[0].split(/\s+/).filter(Boolean).length).toBeGreaterThan(20);
    shown.unmount();
  });
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
    const rebalanceDialog = await openRebalanceDialog(user);
    await user.click(await within(rebalanceDialog).findByRole('button', { name: 'Transfer ▸' }));

    const transferDialog = await screen.findByRole('dialog');
    expect(within(transferDialog).getByRole('radio', { name: 'Into CrossEx' })).toBeChecked();
    expect(within(transferDialog).getByRole('radio', { name: 'USDT · CrossEx' })).toBeChecked();
    expect(scroll.mock.contexts.at(-1)).toContainElement(transfer);
  });

  it('leftover link picks target wallet', async () => {
    const user = userEvent.setup();
    await show(LEFTOVER);
    const rebalanceDialog = await openRebalanceDialog(user);
    await user.click(await within(rebalanceDialog).findByRole('button', { name: 'Transfer ▸' }));

    const transferDialog = await screen.findByRole('dialog');
    expect(within(transferDialog).getByRole('radio', { name: 'Into CrossEx' })).toBeChecked();
    expect(within(transferDialog).getByRole('radio', { name: 'USDC · Hyperliquid' })).toBeChecked();
  });

  it('a USDC line picks the Hyperliquid wallet', async () => {
    const user = userEvent.setup();
    await show({ ...ACCOUNT_B, transfer: transferViews.spotBoth });
    const rebalanceDialog = await openRebalanceDialog(user);
    const links = within(rebalanceDialog).getAllByRole('button', { name: 'Transfer ▸' });
    expect(links).toHaveLength(2);

    await user.click(links[1]);
    const transferDialog = await screen.findByRole('dialog');
    expect(within(transferDialog).getByRole('radio', { name: 'Into CrossEx' })).toBeChecked();
    expect(within(transferDialog).getByRole('radio', { name: 'USDC · Hyperliquid' })).toBeChecked();
  });

  it('a toward USDT leftover picks USDC · Gate', async () => {
    const user = userEvent.setup();
    await show({
      name: 'exampleEAbandoned',
      rebalance: rebalanceViews.exampleEAbandoned,
      transfer: transferViews.noSpot,
      account: accountBodies.exampleE,
    });
    const rebalanceDialog = await openRebalanceDialog(user);
    await user.click(await within(rebalanceDialog).findByRole('button', { name: 'Transfer ▸' }));

    const transferDialog = await screen.findByRole('dialog');
    expect(within(transferDialog).getByRole('radio', { name: 'Into CrossEx' })).toBeChecked();
    expect(within(transferDialog).getByRole('radio', { name: 'USDC · Gate' })).toBeChecked();
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
    expect(within(assets).queryByRole('button', { name: 'Gate spot' })).toBeNull();
    expect(within(assets).getByText(NO_SPOT_READ)).toBeInTheDocument();
    expect(within(assets).getByText('No non-zero balances')).toBeInTheDocument();
  });

  it('an empty CrossEx with no Spot read shows the deposit hint and the spot line', async () => {
    await show({ ...ACCOUNT_B, transfer: transferViews.noSpot, account: accountBodies.noAssets });
    const assets = region('Assets');
    expect(within(assets).getByText('Deposit collateral to CrossEx to get started.')).toBeInTheDocument();
    expect(within(assets).getByText(NO_SPOT_READ)).toBeInTheDocument();
  });

  it('an empty CrossEx with spot money still lists the spot rows', async () => {
    await show({ ...ACCOUNT_B, account: accountBodies.noAssets });
    const assets = region('Assets');
    const rows = assetRows();
    expect(rows.map((row) => row.Coin)).toContain('Gate spot');
    expect(rows.find((row) => row.Coin === 'USDT SPOT')).toMatchObject({ Balance: '318.42', Available: '318.42' });
    expect(within(assets).queryByText('No non-zero balances')).toBeNull();
  });
});
