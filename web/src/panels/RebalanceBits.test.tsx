import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { RebalanceJob, RebalanceStep } from '../api/types';
import { rebalanceViews } from '../test/fixtures';
import { StepDot, StepList, type StepRow } from './RebalanceBits';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { RealizeTab } from './RealizeTab';
import { jobRows, planRows } from './rebalanceStepRows';

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
