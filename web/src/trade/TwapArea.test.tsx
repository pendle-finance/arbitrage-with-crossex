import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useEffect, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PriceImpactPreview, TwapPlanPreview, TwapPlanView } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { baseHandlers, ETH_GATE, symbolHandlers } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { PairTicket } from './PairTicket';
import { StrategyWizard } from './StrategyWizard';
import { useTradeFlow, type StrategyWizardIntent } from './TradeFlow';
import { TwapArea, useTwapInput, type TwapInput } from './TwapArea';

const ETH_PLAN: TwapPlanView = {
  slices: 12,
  sliceQty: '57.803',
  lastQty: '57.807',
  intervalSec: 300,
  durationSec: 3_600,
  takerAfterSec: 240,
};

const ETH_SIZE_PLAN: TwapPlanView = {
  slices: 14,
  sliceQty: '50',
  lastQty: '43.64',
  intervalSec: 257,
  durationSec: 3_600,
  takerAfterSec: 205,
};

const ethPreview = (input: TwapInput): TwapPlanPreview => ({
  plan: input.sliceQty === '50' && input.durationSec === 3_600 ? ETH_SIZE_PLAN : ETH_PLAN,
  refusal: null,
});

const BTC_REFUSED: TwapPlanPreview = {
  plan: null,
  refusal: {
    field: 'sliceSize',
    text: 'Binance takes at least 0.001 BTC ($90) a slice.',
    fix: { label: 'Use 20m interval', patch: { durationSec: 3_600, intervalSec: 1_200 } },
  },
};

const BTC_FIXED: TwapPlanPreview = {
  plan: { slices: 3, sliceQty: '0.001', lastQty: '0.001', intervalSec: 1_200, durationSec: 3_600, takerAfterSec: 960 },
  refusal: null,
};

const btcPreview = (input: TwapInput): TwapPlanPreview => (input.intervalSec === 1_200 ? BTC_FIXED : BTC_REFUSED);

function Ticket({
  previewOf,
  coin,
  impact = null,
  onStart = () => undefined,
}: {
  previewOf: (input: TwapInput) => TwapPlanPreview;
  coin: string;
  impact?: PriceImpactPreview | null;
  onStart?: () => void;
}) {
  const twap = useTwapInput();
  const preview = twap.on ? previewOf(twap.input) : null;
  return (
    <>
      <TwapArea
        on={twap.on}
        onToggle={twap.setOn}
        input={twap.input}
        onInput={twap.setInput}
        preview={preview}
        impact={impact}
        coin={coin}
      />
      <HoldToConfirmButton holdMs={50} disabled={twap.blockedBy(preview)} onConfirm={onStart}>
        Start TWAP
      </HoldToConfirmButton>
    </>
  );
}

const twapSwitch = () => screen.getByRole('switch', { name: 'TWAP' });
const box = (name: string) => screen.getByRole('textbox', { name });

async function turnOn() {
  await userEvent.click(twapSwitch());
}

describe('TwapArea', () => {
  it('switch renders off under limit and hedge', async () => {
    const first = renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" />);
    expect(twapSwitch()).toHaveAttribute('aria-checked', 'false');
    await turnOn();
    expect(twapSwitch()).toHaveAttribute('aria-checked', 'true');
    first.unmount();
    renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" />);
    expect(twapSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('price impact pair from preview', () => {
    const impact: PriceImpactPreview = { whole: 1_320, sliced: 240 };
    renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" impact={impact} />);
    const row = twapSwitch().closest('div.flex') as HTMLElement;
    expect(row).toHaveTextContent(/Price impact.*\$1,320.*\$240/);
    expect(screen.getByText('$240')).toHaveClass('text-grass');
  });

  it('price impact reads too thin when the book ends before the whole size', () => {
    renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" impact={{ whole: null, sliced: 240 }} />);
    expect(twapSwitch().closest('div.flex')).toHaveTextContent(/Price impact.*Book too thin to price.*\$240/);
  });

  it('area opens with three equal boxes', async () => {
    renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" />);
    expect(screen.queryByRole('textbox', { name: 'Duration' })).not.toBeInTheDocument();
    await turnOn();
    const labels = ['Duration', 'Interval', 'Slice size'].map((name) => box(name).closest('label') as HTMLElement);
    expect(new Set(labels.map((label) => label.className)).size).toBe(1);
    expect(labels[0].parentElement).toHaveClass('grid-cols-3');
    expect(labels.every((label) => label.parentElement === labels[0].parentElement)).toBe(true);
  });

  it('default plan 1h 12 slices', async () => {
    renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" />);
    await turnOn();
    expect(box('Duration')).toHaveValue('1h');
    expect(box('Interval')).toHaveValue('5m');
    expect(box('Slice size')).toHaveValue('57.803');
    expect(box('Slice size')).toHaveAttribute('data-source', 'app');
    expect(box('Duration')).toHaveAttribute('data-source', 'typed');
    expect(box('Interval')).toHaveAttribute('data-source', 'typed');
    expect(screen.getByText('Slices 12 · Last slice 57.807 ETH')).toBeInTheDocument();
  });

  it('shows only the slice count when the last slice equals the slice size', async () => {
    renderWithClient(<Ticket previewOf={() => ({ plan: { ...ETH_PLAN, lastQty: ETH_PLAN.sliceQty }, refusal: null })} coin="ETH" />);
    await turnOn();
    expect(screen.getByText('Slices 12')).toBeInTheDocument();
    expect(screen.queryByText(/Last slice/)).not.toBeInTheDocument();
  });

  it('the TWAP switch explains itself on hover', async () => {
    renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" />);
    await userEvent.hover(twapSwitch());
    expect(await screen.findByText('Splits the order into slices sent one interval apart.')).toBeInTheDocument();
  });

  it('switch off closes the area', async () => {
    renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" />);
    await turnOn();
    expect(box('Duration')).toBeInTheDocument();
    await userEvent.click(twapSwitch());
    for (const name of ['Duration', 'Interval', 'Slice size']) {
      expect(screen.queryByRole('textbox', { name })).not.toBeInTheDocument();
    }
  });

  it('the untyped box turns grey', async () => {
    renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" />);
    await turnOn();
    await userEvent.clear(box('Duration'));
    await userEvent.type(box('Duration'), '1h');
    await userEvent.clear(box('Slice size'));
    await userEvent.type(box('Slice size'), '50');
    await userEvent.tab();
    expect(box('Interval')).toHaveAttribute('data-source', 'app');
    expect(box('Interval')).toHaveClass('text-ink-400');
    expect(box('Interval')).toHaveValue('4m 17s');
    expect(box('Duration')).toHaveAttribute('data-source', 'typed');
    expect(box('Slice size')).toHaveAttribute('data-source', 'typed');
    expect(box('Slice size')).toHaveValue('50');
  });

  it('typing the grey box makes it typed and greys the oldest', async () => {
    renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" />);
    await turnOn();
    await userEvent.clear(box('Interval'));
    await userEvent.type(box('Interval'), '5m');
    await userEvent.clear(box('Slice size'));
    await userEvent.type(box('Slice size'), '50');
    expect(box('Duration')).toHaveAttribute('data-source', 'app');
    expect(box('Interval')).toHaveAttribute('data-source', 'typed');
  });

  it('a time box that does not parse turns red and reverts on blur', async () => {
    renderWithClient(<Ticket previewOf={ethPreview} coin="ETH" />);
    await turnOn();
    await userEvent.clear(box('Duration'));
    await userEvent.type(box('Duration'), 'abc');
    expect(box('Duration')).toHaveAttribute('aria-invalid', 'true');
    await userEvent.tab();
    expect(box('Duration')).toHaveValue('1h');
    expect(box('Duration')).not.toHaveAttribute('aria-invalid');
  });

  it('slice under minimum turns the box red', async () => {
    renderWithClient(<Ticket previewOf={btcPreview} coin="BTC" />);
    await turnOn();
    expect(box('Slice size')).toHaveAttribute('aria-invalid', 'true');
    expect(box('Slice size')).toHaveClass('!border-rose-500/60');
    expect(box('Interval')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText(/Binance takes at least 0\.001 BTC \(\$90\) a slice\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use 20m interval' })).toBeInTheDocument();
  });

  it('refused plan blocks the hold', async () => {
    const onStart = vi.fn();
    renderWithClient(<Ticket previewOf={btcPreview} coin="BTC" onStart={onStart} />);
    await turnOn();
    const start = screen.getByRole('button', { name: /Start TWAP/ });
    expect(start).toBeDisabled();
    fireEvent.pointerDown(start);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fireEvent.pointerUp(start);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('one-click fix applies', async () => {
    const onStart = vi.fn();
    renderWithClient(<Ticket previewOf={btcPreview} coin="BTC" onStart={onStart} />);
    await turnOn();
    await userEvent.click(screen.getByRole('button', { name: 'Use 20m interval' }));
    expect(box('Interval')).toHaveValue('20m');
    expect(screen.queryByText(/Binance takes at least/)).not.toBeInTheDocument();
    expect(box('Slice size')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('button', { name: /Start TWAP/ })).toBeEnabled();
  });

  it('turn TWAP off fix closes the area', async () => {
    const tooSmall: TwapPlanPreview = {
      plan: null,
      refusal: {
        field: 'sliceSize',
        text: 'Too small for 2 slices: Binance takes at least 0.001 BTC ($90) a slice.',
        fix: { label: 'Turn TWAP off', patch: {} },
      },
    };
    renderWithClient(<Ticket previewOf={() => tooSmall} coin="BTC" />);
    await turnOn();
    await userEvent.click(screen.getByRole('button', { name: 'Turn TWAP off' }));
    expect(twapSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('textbox', { name: 'Duration' })).not.toBeInTheDocument();
  });

  it('no switch with market', async () => {
    server.use(...baseHandlers(), ...symbolHandlers([ETH_GATE]));
    renderWithClient(<PairTicket />);
    await userEvent.click(await screen.findByRole('radio', { name: /market/i }));
    expect(screen.getByRole('radio', { name: /market/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('switch', { name: 'TWAP' })).not.toBeInTheDocument();
  });

  it('wizard has no switch', async () => {
    const intent: StrategyWizardIntent = {
      base: 'ETH',
      borosLongVenue: 'BINANCE',
      borosShortVenue: 'HYPERLIQUID',
      maturity: 1_760_000_000,
      crossexLongVenue: 'OKX',
      crossexShortVenue: 'GATE',
      notionalUsd: 10_000,
      perpMode: 'maker',
      initialStep: 2,
    };
    function Launch() {
      const flow = useTradeFlow();
      const fired = useRef(false);
      useEffect(() => {
        if (fired.current) return;
        fired.current = true;
        flow.openWizard(intent);
      }, [flow]);
      return null;
    }
    server.use(
      ...baseHandlers(),
      http.get('/api/books/:symbol', ({ params }) =>
        HttpResponse.json(env({ symbol: String(params.symbol), bestBid: 2499, bestAsk: 2501, mid: 2500 })),
      ),
      http.get('/api/boros/agent', () =>
        HttpResponse.json(
          env({ configured: false, root: null, rootMasked: null, accountId: 0, expiry: null, expired: false, canProvision: true }),
        ),
      ),
      http.get('/api/boros/pair/context', () => HttpResponse.json(env({ markets: [] }))),
      ...symbolHandlers([ETH_GATE]),
    );
    renderWithClient(
      <>
        <Launch />
        <StrategyWizard />
      </>,
    );
    await screen.findByLabelText(/Size per leg/, undefined, { timeout: 4000 });
    await waitFor(() => expect(screen.queryByRole('switch', { name: 'TWAP' })).not.toBeInTheDocument());
  });
});
