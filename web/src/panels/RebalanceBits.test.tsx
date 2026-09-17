import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RebalanceJob, RebalanceStep } from '../api/types';
import { rebalanceViews } from '../test/fixtures';
import { BAR_CAPTION, HOVER_TARGET, SHARE_CAPTION } from './rebalanceCopy';
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

const openHover = (container: HTMLElement, key: string): HTMLElement => {
  fireEvent.mouseMove(partOf(rowOf(container, key), 'bar-hit'), { clientX: 100, clientY: 40 });
  return screen.getByRole('tooltip');
};

describe('BalanceBars', () => {
  it('cash fill', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const row = rowOf(container, 'USDT/CROSSEX');
    const cash = partOf(row, 'bar-cash');
    expect(cash.style.left).toBe('50%');
    expect(cash.style.width).toBe('30%');
    expect(cash.className).toContain('bg-grass');
    expect(partOf(row, 'zero-line').style.left).toBe(cash.style.left);
  });

  it('a positive cash bar is grass, a negative one is guava', () => {
    const positive = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);
    expect(partOf(rowOf(positive.container, 'USDT/CROSSEX'), 'bar-cash').className).toContain('bg-grass');
    positive.unmount();

    const rows: BarRow[] = [{ key: 'USDC/LIGHTER', label: 'USDC · Lighter', cash: -40, upnl: 5, target: 30, tone: 'lighter' }];
    const negative = render(<BalanceBars caption={BAR_CAPTION} rows={rows} scale={100} />);
    expect(partOf(rowOf(negative.container, 'USDC/LIGHTER'), 'bar-cash').className).toContain('bg-guava');
  });

  it('pnl fill', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const loss = partOf(rowOf(container, 'USDT/CROSSEX'), 'bar-pnl');
    expect(loss.className).toContain('bar-pnl-loss');
    expect(loss.style.left).toBe('75%');
    expect(loss.style.width).toBe('5%');
    expect(edge(loss)).toBe(edge(partOf(rowOf(container, 'USDT/CROSSEX'), 'bar-cash')));

    const gainRow = rowOf(container, 'USDC/LIGHTER');
    const gain = partOf(gainRow, 'bar-pnl');
    expect(gain.className).toContain('bar-pnl-gain');
    expect(gain.style.left).toBe('60%');
    expect(gain.style.width).toBe('2.5%');
    expect(Number(gain.style.left.replace('%', ''))).toBe(edge(partOf(gainRow, 'bar-cash')));
  });

  it('negative cash bar is guava', () => {
    const rows: BarRow[] = [{ key: 'USDC/LIGHTER', label: 'USDC · Lighter', cash: -40, upnl: 55, target: 15, tone: 'lighter' }];
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={rows} scale={80} />);

    const row = rowOf(container, 'USDC/LIGHTER');
    const cash = partOf(row, 'bar-cash');
    expect(cash.className).toContain('bg-guava');
    expect(cash.className).not.toContain('bg-grass');
    expect(cash.className).not.toContain('bar-pnl-loss');
    expect(cash.style.left).toBe('25%');
    expect(cash.style.width).toBe('25%');
    expect(partOf(row, 'zero-line').style.left).toBe('50%');
  });

  it('target mark', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const mark = partOf(rowOf(container, 'USDT/CROSSEX'), 'bar-target');
    expect(mark.className).toContain('bg-gold');
    expect(mark.className).toContain('w-0.5');
    expect(mark.style.left).toBe('72.5%');
    expect(partOf(rowOf(container, 'USDC/LIGHTER'), 'bar-target').style.left).toBe('65%');
  });

  it('no legend', () => {
    render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    expect(screen.getByText(BAR_CAPTION)).toBeInTheDocument();
    expect('BarLegend' in bits).toBe(false);
    expect(screen.queryByText('unrealized gain')).toBeNull();
    expect(screen.queryByText('cash')).toBeNull();
  });

  it('zero line reaches past the bar', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const line = partOf(rowOf(container, 'USDT/CROSSEX'), 'zero-line');
    expect(line.style.left).toBe('50%');
    expect(line.className).toContain('-inset-y-[5px]');
  });

  it('bar looks hoverable', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const hit = partOf(rowOf(container, 'USDC/LIGHTER'), 'bar-hit');
    expect(hit.className).toContain('cursor-pointer');
    expect(hit.tabIndex).toBe(0);
  });

  it('zero line is centered', () => {
    const plain = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={bits.scaleOf(ROWS)} />);
    for (const row of ROWS) expect(partOf(rowOf(plain.container, row.key), 'zero-line').style.left).toBe('50%');
    plain.unmount();

    const book: BarRow[] = [
      { key: 'USDT/CROSSEX', label: 'USDT · CrossEx', cash: 30, upnl: 0, target: 0, tone: 'usdt' },
      { key: 'USDC/LIGHTER', label: 'USDC · Lighter', cash: -30, upnl: 0, target: 0, tone: 'lighter' },
    ];
    const scale = bits.scaleOf(ROWS, book);
    expect(scale).toBe(60);
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={book} scale={scale} />);

    const positive = rowOf(container, 'USDT/CROSSEX');
    const negative = rowOf(container, 'USDC/LIGHTER');
    expect(partOf(positive, 'zero-line').style.left).toBe('50%');
    expect(partOf(negative, 'zero-line').style.left).toBe('50%');
    expect([partOf(positive, 'bar-cash').style.left, partOf(positive, 'bar-cash').style.width]).toEqual(['50%', '25%']);
    expect([partOf(negative, 'bar-cash').style.left, partOf(negative, 'bar-cash').style.width]).toEqual(['25%', '25%']);
    expect(partOf(negative, 'bar-target').style.left).toBe('50%');
  });

  it('scale takes the widest end on either side', () => {
    const negativeOnly: BarRow[] = [{ key: 'USDC/LIGHTER', label: 'USDC · Lighter', cash: -90, upnl: 20, target: 10, tone: 'lighter' }];
    expect(bits.scaleOf(ROWS, negativeOnly)).toBe(90);
    expect(bits.scaleOf([])).toBe(0);
  });

  it('negative cash is guava even without a borrow', () => {
    const [bucket] = rebalanceViews.gainOverNegativeCash.buckets;
    expect(bucket.borrow).toBe(0);
    const rows: BarRow[] = [
      { key: 'USDC/LIGHTER', label: 'USDC · Lighter', cash: bucket.cash, upnl: bucket.upnl, target: bucket.equity, tone: 'lighter' },
    ];
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={rows} scale={60} />);

    const row = rowOf(container, 'USDC/LIGHTER');
    const cash = partOf(row, 'bar-cash');
    expect(Number(cash.style.left.replace('%', ''))).toBeLessThan(Number(partOf(row, 'zero-line').style.left.replace('%', '')));
    expect(cash.className).toContain('bg-guava');
    expect(partOf(row, 'bar-pnl').className).toContain('bar-pnl-gain');
    expect(row.textContent).toBe('USDC · Lighter15.00');
  });
});

describe('the wallet hover', () => {
  it('bar tooltip follows the pointer', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);
    const row = rowOf(container, 'USDC/LIGHTER');
    const hit = partOf(row, 'bar-hit');

    fireEvent.mouseMove(hit, { clientX: 100, clientY: 40 });
    const first = screen.getByRole('tooltip');
    expect([first.style.left, first.style.top]).toEqual(['112px', '52px']);

    fireEvent.mouseMove(hit, { clientX: 220, clientY: 60 });
    const second = screen.getByRole('tooltip');
    expect([second.style.left, second.style.top]).toEqual(['232px', '72px']);

    expect(within(row).queryByRole('button')).toBeNull();
    expect(row.querySelector('[class*="border-dotted"]')).toBeNull();
    expect(row.className).not.toContain('border-dotted');

    fireEvent.mouseLeave(hit);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('hover names the wallet', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const card = openHover(container, 'USDC/LIGHTER');
    expect(card.firstElementChild?.firstElementChild?.textContent).toBe('USDC · Lighter');
  });

  it('hover title is the plain name, never the label hover', () => {
    const rows: BarRow[] = [
      { ...ROWS[1], label: <span className="border-b border-dotted decoration-dotted">USDC · Lighter</span>, name: 'USDC · Lighter' },
    ];
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={rows} scale={100} />);

    const card = openHover(container, 'USDC/LIGHTER');
    expect(card.firstElementChild?.firstElementChild?.textContent).toBe('USDC · Lighter');
    expect(card.querySelector('[class*="border-dotted"], [class*="decoration-dotted"]')).toBeNull();
  });

  it('hover has three numbers', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const card = openHover(container, 'USDC/LIGHTER');
    expect(within(card).getByText('Cash')).toBeInTheDocument();
    expect(within(card).getByText('Unrealized PnL')).toBeInTheDocument();
    expect(within(card).getByText(HOVER_TARGET)).toBeInTheDocument();
    expect([...card.querySelectorAll('.num')].map((el) => el.textContent)).toEqual(['20.00', '+5.00', '30.00']);
  });

  it('hover swatches', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const card = openHover(container, 'USDC/LIGHTER');
    expect(card.querySelector('[data-swatch="cash"]')?.className).toContain('bg-grass');
    expect(card.querySelector('[data-swatch="pnl"]')?.className).toContain('bar-pnl-gain');
    expect(card.querySelector('[data-swatch="target"]')?.className).toContain('bg-gold');
  });

  it('hover omits equity', () => {
    const { container } = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={100} />);

    const card = openHover(container, 'USDC/LIGHTER');
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

describe('jobRows for a Convert in chunks', () => {
  const base = rebalanceViews.accountADone.job!;
  const chunk = (name: string, planned: number, qty: number | null, status: RebalanceStep['status'], to: RebalanceStep['to'] = 'HYPERLIQUID'): RebalanceStep => ({
    ...base.steps[0],
    name,
    from: to === 'LIGHTER' ? 'HYPERLIQUID' : 'CROSSEX',
    to,
    round: null,
    planned,
    qty,
    status,
    arrives: null,
    borrowLeft: null,
    startedAt: status === 'pending' ? null : 1_000,
    doneAt: status === 'done' ? 2_000 : null,
  });
  const jobOf = (steps: RebalanceStep[], stepIndex: number, status: RebalanceJob['status']): RebalanceJob => ({
    ...base,
    route: 'convert',
    status,
    stepIndex,
    steps,
    updatedAt: 2_000,
  });

  it('a done Convert of three chunks shows one row with the summed move and the summed arrival', () => {
    const job = jobOf(
      [chunk('Convert', 400_000, 399_200, 'done'), chunk('Convert', 400_000, 399_200, 'done'), chunk('Convert', 400_000, 399_200, 'done')],
      2,
      'done',
    );

    const rows = bits.jobRows(job, 3_000, null);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Convert', state: 'done', sub: '1,197,600.00 arrives' });
    expect(rows[0].text).toContain('1,200,000.00');
  });

  it('a running Convert of three chunks shows the summed move and no arrival', () => {
    const job = jobOf(
      [chunk('Convert', 400_000, 399_200, 'done'), chunk('Convert', 400_000, 399_200, 'running'), chunk('Convert', 400_000, null, 'pending')],
      1,
      'running',
    );

    const rows = bits.jobRows(job, 3_000, null);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Convert', state: 'running', sub: '' });
    expect(rows[0].text).toContain('1,200,000.00');
  });

  it('a done Convert of two pairs between Hyperliquid and Lighter moves the Convert to USDT sum and lands the Convert to USDC sum', () => {
    const job = jobOf(
      [
        chunk('Convert to USDT', 300_000, 299_400, 'done', 'LIGHTER'),
        chunk('Convert to USDC', 299_400, 298_801.2, 'done', 'LIGHTER'),
        chunk('Convert to USDT', 300_000, 299_400, 'done', 'LIGHTER'),
        chunk('Convert to USDC', 299_400, 298_801.2, 'done', 'LIGHTER'),
      ],
      3,
      'done',
    );

    const rows = bits.jobRows(job, 3_000, null);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'done', sub: '597,602.40 arrives' });
    expect(rows[0].text).toContain('600,000.00');
  });

  it('one Convert chunk shows the same row as before chunks existed', () => {
    const job = jobOf([chunk('Convert', 12, 11.97, 'done')], 0, 'done');

    const [row] = bits.jobRows(job, 3_000, null);

    expect(row).toMatchObject({ state: 'done', sub: '11.97 arrives' });
    expect(row.text).toContain('12.00');
  });
});
