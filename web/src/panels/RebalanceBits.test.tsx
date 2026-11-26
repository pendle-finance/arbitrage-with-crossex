import { fireEvent, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { RebalanceJob, RebalanceStep } from '../api/types';
import { rebalanceViews } from '../test/fixtures';
import * as bars from './RebalanceBars';
import { BalanceBars, scaleOf, type BarRow } from './RebalanceBars';
import { StepDot, StepList, type StepRow } from './RebalanceBits';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RealizeTab } from './RealizeTab';
import { jobRows, planRows } from './rebalanceStepRows';

const BAR_CAPTION = 'Equity (cash + unrealized PnL)';
const HOVER_TARGET = 'Balanced target';

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
    expect('BarLegend' in bars).toBe(false);
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
    const plain = render(<BalanceBars caption={BAR_CAPTION} rows={ROWS} scale={scaleOf(ROWS)} />);
    for (const row of ROWS) expect(partOf(rowOf(plain.container, row.key), 'zero-line').style.left).toBe('50%');
    plain.unmount();

    const book: BarRow[] = [
      { key: 'USDT/CROSSEX', label: 'USDT · CrossEx', cash: 30, upnl: 0, target: 0, tone: 'usdt' },
      { key: 'USDC/LIGHTER', label: 'USDC · Lighter', cash: -30, upnl: 0, target: 0, tone: 'lighter' },
    ];
    const scale = scaleOf(ROWS, book);
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
    expect(scaleOf(ROWS, negativeOnly)).toBe(90);
    expect(scaleOf([])).toBe(0);
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
    expect([...card.querySelectorAll('.num')].map((el) => el.textContent)).toEqual(['20.00', '5.00', '30.00']);
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
  const STEP_ROWS = [
    { key: 'r1', coin: 'USDC', text: 'Move 100 USDC to Lighter', sub: 'Gate spot to Lighter', right: '01:02 of 02:00', state: 'running', progress: 0.5 },
    { key: 'r2', coin: 'USDC', text: 'Move 50 USDC to Lighter', sub: '50 arrives', right: 'about 2 min', state: 'pending', progress: 0 },
    { key: 'r3', coin: 'USDC', text: 'Move 25 USDC to Lighter', sub: '25 arrives', right: 'about 1 min', state: 'pending', progress: 0 },
  ] satisfies StepRow[];

  it('one bordered row per step with its text and time, the leg and a bar only while running', () => {
    const { container } = render(<StepList rows={STEP_ROWS} />);

    const items = [...container.querySelectorAll('li')];
    expect(items).toHaveLength(STEP_ROWS.length);
    items.forEach((item, index) => {
      const row = STEP_ROWS[index];
      expect(item.className).toContain('rounded border');
      expect(within(item).getByText(row.text)).toBeInTheDocument();
      expect(within(item).getByText(row.right)).toBeInTheDocument();
    });
    expect(within(items[0]).getByText('Gate spot to Lighter')).toBeInTheDocument();
    expect(screen.queryByText('50 arrives')).toBeNull();
    expect(items[0].querySelector<HTMLElement>('[data-step-bar]')?.style.width).toBe('50%');
    expect(items[1].querySelector('[data-step-bar]')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('a limit shows the first rows and any running row, numbered as in the full list', () => {
    const rows: StepRow[] = [1, 2, 3, 4, 5].map((n) => ({
      key: String(n), coin: 'USDC', text: `Round ${n}`, sub: '', right: '', state: n === 4 ? 'running' : 'pending', progress: 0,
    }));
    const { container } = render(<StepList rows={rows} limit={2} />);

    expect([...container.querySelectorAll('[data-step-dot]')].map((dot) => dot.textContent)).toEqual(['1', '2', '']);
    expect(screen.getByText('Round 4')).toBeInTheDocument();
    expect(screen.queryByText('Round 3')).toBeNull();
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
    goal: 'even', route: 'convert',
    status,
    stepIndex,
    steps,
    updatedAt: 2_000,
  });

  it('a done Convert of three chunks shows one row with the summed move', () => {
    const job = jobOf(
      [chunk('Convert', 400_000, 399_200, 'done'), chunk('Convert', 400_000, 399_200, 'done'), chunk('Convert', 400_000, 399_200, 'done')],
      2,
      'done',
    );

    const rows = jobRows(job, 3_000);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ coin: 'USDT', state: 'done', sub: '' });
    expect(rows[0].text).toContain('1,200,000.00');
  });

  it('a running Convert of three chunks shows the summed move', () => {
    const job = jobOf(
      [chunk('Convert', 400_000, 399_200, 'done'), chunk('Convert', 400_000, 399_200, 'running'), chunk('Convert', 400_000, null, 'pending')],
      1,
      'running',
    );

    const rows = jobRows(job, 3_000);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ coin: 'USDT', state: 'running' });
    expect(rows[0].text).toContain('1,200,000.00');
  });

  it('a done Convert of two pairs between Hyperliquid and Lighter moves the Convert to USDT sum', () => {
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

    const rows = jobRows(job, 3_000);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ coin: 'USDC', state: 'done', sub: '' });
    expect(rows[0].text).toContain('600,000.00');
  });

  it('one Convert chunk shows the same row as before chunks existed', () => {
    const job = jobOf([chunk('Convert', 12, 11.97, 'done')], 0, 'done');

    const [row] = jobRows(job, 3_000);

    expect(row).toMatchObject({ state: 'done', sub: '' });
    expect(row.text).toContain('12.00');
  });
});

describe('the idle Gate USDC sale', () => {
  const IDLE = 'Sell 111.96 idle USDC in the CrossEx Gate wallet for USDT';
  const convert = rebalanceViews.accountA.plans.even.routes.convert;

  it('the plan lists the sale as its own instant row before the Convert', () => {
    const rows = planRows(convert);

    expect(rows.map((row) => row.text)).toEqual([IDLE, expect.stringContaining('175.94')]);
    expect(rows[0]).toMatchObject({ coin: 'USDC', state: 'pending', right: 'Instant' });
  });

  it('the plan puts a round-out sale after the round it rides with', () => {
    const loop = rebalanceViews.accountA.plans.even.routes.loop!;
    const rows = planRows({ ...loop, idleSale: { usdc: 111.96, at: 1 } });

    expect(rows).toHaveLength(loop.steps.length + 1);
    expect(rows[1].text).toBe(IDLE);
  });

  it('a plan with no sale, or a sale of 0, lists only its steps', () => {
    expect(planRows({ ...convert, idleSale: null })).toHaveLength(1);
    expect(planRows({ ...convert, idleSale: { usdc: 0, at: 0 } })).toHaveLength(1);
  });

  it('a job shows the sale the runner adds before a Convert as its own row', () => {
    const base = rebalanceViews.accountADone.job!;
    const step = (name: string, planned: number, status: RebalanceStep['status']): RebalanceStep => ({
      ...base.steps[0], name, from: 'CROSSEX', to: 'HYPERLIQUID', round: null, planned, qty: null, status,
      arrives: null, borrowLeft: null, startedAt: status === 'pending' ? null : 1_000, doneAt: status === 'done' ? 2_000 : null,
    });
    const job: RebalanceJob = {
      ...base, goal: 'even', route: 'convert', status: 'running', stepIndex: 1, updatedAt: 2_000,
      steps: [step('Sell USDC', 111.96, 'done'), step('Convert', 175.94, 'running')],
    };

    const rows = jobRows(job, 3_000);

    expect(rows.map((row) => row.text)).toEqual([IDLE, expect.stringContaining('175.94')]);
    expect(rows.map((row) => row.state)).toEqual(['done', 'running']);
    expect(rows[0].coin).toBe('USDC');
  });
});

describe('StepDot', () => {
  it('numbers a pending step, spins a running one, ticks a done one and reds a stopped one', () => {
    const { container, rerender } = render(<StepDot n={2} state="pending" />);
    const dot = () => container.querySelector<HTMLElement>('[data-step-dot]')!;
    expect(dot().textContent).toBe('2');
    expect(dot().className).toContain('text-ink-400');

    rerender(<StepDot n={2} state="running" />);
    expect(dot().querySelector('.animate-spin')).not.toBeNull();
    expect(dot().className).toContain('text-info');

    rerender(<StepDot n={2} state="done" />);
    expect(dot().querySelector('svg')).not.toBeNull();
    expect(dot().textContent).toBe('');
    expect(dot().className).toContain('text-grass');

    rerender(<StepDot n={2} state="stopped" />);
    expect(dot().textContent).toBe('2');
    expect(dot().className).toContain('text-guava');
  });

  it('StepList numbers its steps in order with one dot each', () => {
    const rows: StepRow[] = [
      { key: 'a', coin: 'USDC', text: 'Convert 500.00 USDC', sub: '', right: '3s', state: 'done', progress: 1 },
      { key: 'b', coin: 'USDT', text: 'Convert 20.00 USDT', sub: '', right: 'Instant', state: 'pending', progress: 0 },
    ];
    const { container } = render(<StepList rows={rows} />);

    const dots = [...container.querySelectorAll('[data-step-dot]')];
    expect(dots.map((dot) => dot.getAttribute('data-step-dot'))).toEqual(['done', 'pending']);
    expect(dots[1].textContent).toBe('2');
    expect(container.querySelector('[data-step-bar]')).toBeNull();
  });
});

describe('Realize uPnL tab', () => {
  it('realize has no twap', async () => {
    server.use(http.get('/api/rebalance', () => HttpResponse.json(env(rebalanceViews.accountA))));
    renderWithClient(<RealizeTab view={rebalanceViews.accountA} lock={null} onTab={() => {}} onStarted={() => {}} />);
    expect(screen.queryByRole('switch', { name: 'TWAP' })).not.toBeInTheDocument();
    expect(screen.queryByText('TWAP')).not.toBeInTheDocument();
  });
});
