import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { rebalanceViews } from '../test/fixtures';
import { BAR_CAPTION, SHARE_CAPTION } from './rebalanceCopy';
import * as bits from './RebalanceBits';
import { BalanceBars, ShareColumn, StepList, type BarRow, type StepRow } from './RebalanceBits';

const ROWS: BarRow[] = [
  { key: 'USDT/CROSSEX', label: 'USDT · CrossEx', cash: 60, upnl: -10, target: 45, tone: 'usdt' },
  { key: 'USDC/LIGHTER', label: 'USDC · Lighter', cash: 20, upnl: 5, target: 30, tone: 'lighter' },
];

const rowOf = (container: HTMLElement, key: string): HTMLElement => {
  const row = container.querySelector<HTMLElement>(`[data-bar-row="${key}"]`);
  if (!row) throw new Error(`no bar row ${key}`);
  return row;
};

const partOf = (row: HTMLElement, part: string): HTMLElement => {
  const el = row.querySelector<HTMLElement>(`[data-${part}]`);
  if (!el) throw new Error(`no ${part} in the row`);
  return el;
};

const edge = (el: HTMLElement): number => Number(el.style.left.replace('%', '')) + Number(el.style.width.replace('%', ''));

const openHover = async (container: HTMLElement, key: string): Promise<HTMLElement> => {
  await userEvent.hover(within(rowOf(container, key)).getByRole('button'));
  return screen.findByRole('tooltip');
};

describe('BalanceBars', () => {
  it('cash fill', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const row = rowOf(container, 'USDT/CROSSEX');
    const cash = partOf(row, 'bar-cash');
    expect(cash.style.left).toBe('0%');
    expect(cash.style.width).toBe('60%');
    expect(cash.className).toContain('bg-info');
    expect(partOf(row, 'zero-line').style.left).toBe(cash.style.left);
  });

  it('pnl fill', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const loss = partOf(rowOf(container, 'USDT/CROSSEX'), 'bar-pnl');
    expect(loss.className).toContain('bar-pnl-loss');
    expect(loss.style.left).toBe('50%');
    expect(loss.style.width).toBe('10%');
    expect(edge(loss)).toBe(edge(partOf(rowOf(container, 'USDT/CROSSEX'), 'bar-cash')));

    const gainRow = rowOf(container, 'USDC/LIGHTER');
    const gain = partOf(gainRow, 'bar-pnl');
    expect(gain.className).toContain('bar-pnl-gain');
    expect(gain.style.left).toBe('20%');
    expect(gain.style.width).toBe('5%');
    expect(Number(gain.style.left.replace('%', ''))).toBe(edge(partOf(gainRow, 'bar-cash')));
  });

  it('negative cash keeps its colour', () => {
    const rows: BarRow[] = [{ key: 'USDC/LIGHTER', label: 'USDC · Lighter', cash: -40, upnl: 55, target: 15, tone: 'lighter' }];
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={rows} scale={60} />);

    const row = rowOf(container, 'USDC/LIGHTER');
    const cash = partOf(row, 'bar-cash');
    expect(cash.className).toContain('bg-grass');
    expect(cash.className).not.toContain('guava');
    expect(cash.className).not.toContain('bar-pnl-loss');
    expect(cash.style.left).toBe('0%');
    expect(cash.style.width).toBe('40%');
    expect(partOf(row, 'zero-line').style.left).toBe('40%');
  });

  it('target mark', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const mark = partOf(rowOf(container, 'USDT/CROSSEX'), 'bar-target');
    expect(mark.className).toContain('bg-gold');
    expect(mark.className).toContain('w-0.5');
    expect(mark.style.left).toBe('45%');
    expect(partOf(rowOf(container, 'USDC/LIGHTER'), 'bar-target').style.left).toBe('30%');
  });

  it('no legend', () => {
    render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    expect(screen.getByText('Now against target')).toBeInTheDocument();
    expect('BarLegend' in bits).toBe(false);
    expect(screen.queryByText('unrealized gain')).toBeNull();
    expect(screen.queryByText('cash')).toBeNull();
  });

  it('bar looks hoverable', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const trigger = within(rowOf(container, 'USDC/LIGHTER')).getByRole('button');
    expect(trigger.className).toContain('border-dotted');
    expect(trigger.className).toContain('cursor-help');
  });

  it('negative cash without a borrow', () => {
    const [bucket] = rebalanceViews.gainOverNegativeCash.buckets;
    expect(bucket.borrow).toBe(0);
    const rows: BarRow[] = [
      { key: 'USDC/LIGHTER', label: 'USDC · Lighter', cash: bucket.cash, upnl: bucket.upnl, target: bucket.equity, tone: 'lighter' },
    ];
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={rows} scale={60} />);

    const row = rowOf(container, 'USDC/LIGHTER');
    const cash = partOf(row, 'bar-cash');
    expect(Number(cash.style.left.replace('%', ''))).toBeLessThan(Number(partOf(row, 'zero-line').style.left.replace('%', '')));
    expect(cash.className).toContain('bg-grass');
    expect(partOf(row, 'bar-pnl').className).toContain('bar-pnl-gain');
    expect(row.textContent).toBe('USDC · Lighter15.00');
  });
});

describe('the wallet hover', () => {
  it('hover names the wallet', async () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const card = await openHover(container, 'USDC/LIGHTER');
    expect(card.firstElementChild?.firstElementChild?.textContent).toBe('USDC · Lighter');
  });

  it('hover has three numbers', async () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const card = await openHover(container, 'USDC/LIGHTER');
    expect(within(card).getByText('Cash')).toBeInTheDocument();
    expect(within(card).getByText('Unrealized PnL')).toBeInTheDocument();
    expect(within(card).getByText('Balanced equity')).toBeInTheDocument();
    expect([...card.querySelectorAll('.num')].map((el) => el.textContent)).toEqual(['20.00', '+5.00', '30.00']);
  });

  it('hover swatches', async () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const card = await openHover(container, 'USDC/LIGHTER');
    expect(card.querySelector('[data-swatch="cash"]')?.className).toContain('bg-grass');
    expect(card.querySelector('[data-swatch="pnl"]')?.className).toContain('bar-pnl-gain');
    expect(card.querySelector('[data-swatch="target"]')?.className).toContain('bg-gold');
  });

  it('hover omits equity', async () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const card = await openHover(container, 'USDC/LIGHTER');
    expect(within(card).queryByText('25.00')).toBeNull();
    expect(within(card).queryByText('Equity')).toBeNull();
  });
});

describe('StepList', () => {
  const STEP_ROWS: StepRow[] = [
    { key: 'r1', label: 'Round 1', text: 'Move 100 USDC to Lighter', sub: '100 arrives', right: '01:02 of 02:00', state: 'running', progress: 0.5 },
    { key: 'r2', label: 'Round 2', text: 'Move 50 USDC to Lighter', sub: '50 arrives', right: 'about 2 min', state: 'pending', progress: 0 },
    { key: 'r3', label: 'Round 3', text: 'Move 25 USDC to Lighter', sub: '25 arrives', right: 'about 1 min', state: 'pending', progress: 0 },
  ];

  it('clock binds to its own round', () => {
    const { container } = render(<StepList rows={STEP_ROWS} />);

    const list = container.querySelector('ol');
    expect(list?.className).toContain('gap-5');
    expect(list?.className).not.toContain('gap-3');

    const items = container.querySelectorAll('li');
    expect(items.length).toBe(STEP_ROWS.length);
    items.forEach((item, index) => {
      const row = STEP_ROWS[index];
      expect(within(item as HTMLElement).getByText(row.sub)).toBeInTheDocument();
      const timeRow = within(item as HTMLElement).getByText(row.right).closest('div');
      expect(timeRow?.className).toContain('items-end');
      expect(timeRow?.className).not.toContain('items-start');
    });
  });
});

describe('ShareColumn', () => {
  it('position share column', () => {
    const shares = new Map([
      ['USDT/CROSSEX', '50% · $1,873'],
      ['USDC/LIGHTER', '6% · $240'],
    ]);
    render(<ShareColumn caption={SHARE_CAPTION} rows={ROWS} shares={shares} />);

    expect(screen.getByText('Position share')).toBeInTheDocument();
    expect(screen.getByText('50% · $1,873')).toBeInTheDocument();
    expect(screen.getByText('6% · $240')).toBeInTheDocument();
  });
});
