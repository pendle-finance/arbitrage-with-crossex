/**
 * The pair-close form's slippage control.
 *
 * This path used to send NO `slippagePct` at all and expose no input, so the
 * user's setting was silently the 0.5% default — the setting was not
 * "respected" because it could not be expressed. The single-leg ClosePopover
 * always had the control; this is the two-leg surface catching up.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ActionInput, PreviewResponse } from '../api/types';
import { baseHandlers, previewFor } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { ClosePairForm } from './PerpOnlyBox';

const LEGS = [
  { symbol: 'BYBIT_FUTURE_HYPE_USDT', qty: 1.89, venue: 'BYBIT' },
  { symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', qty: 1.89, venue: 'HYPERLIQUID' },
];

/** Captures every previewed action so we can read the slippage actually sent. */
function previewSpy(seen: ActionInput[][]) {
  return http.post('/api/preview', async ({ request }) => {
    const { actions } = (await request.json()) as { actions: ActionInput[] };
    seen.push(actions);
    return HttpResponse.json(
      env<PreviewResponse>({
        previews: actions.map((a) =>
          previewFor(a, {
            side: 'SELL',
            type: 'LIMIT',
            tif: 'IOC',
            reduceOnly: true,
            qty: '1.89',
            price: '80',
            estNotional: 151,
            closing: { positionQty: '1.89', upnl: '1', mark: 80 },
          }),
        ),
      }),
    );
  });
}

describe('ClosePairForm — the slippage the user sets is the slippage sent', () => {
  it('sends the typed slippage on BOTH legs', async () => {
    const seen: ActionInput[][] = [];
    server.use(...baseHandlers(), previewSpy(seen));
    renderWithClient(<ClosePairForm base="HYPE" legs={LEGS} />);

    await waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 4000 });
    // The default is stated, not implied.
    const slipOf = (as: ActionInput[]) =>
      as.map((a) => (a.kind === 'close-position' ? a.slippagePct : undefined));
    expect(slipOf(seen.at(-1)!)).toEqual([0.5, 0.5]);

    const slip = screen.getByLabelText('Slippage %');
    await userEvent.clear(slip);
    await userEvent.type(slip, '2');

    // Both legs, not just the one that carries the band.
    await waitFor(() => expect(slipOf(seen.at(-1)!)).toEqual([2, 2]), { timeout: 4000 });
  });

  it('refuses an out-of-range slippage instead of silently defaulting', async () => {
    const seen: ActionInput[][] = [];
    server.use(...baseHandlers(), previewSpy(seen));
    renderWithClient(<ClosePairForm base="HYPE" legs={LEGS} />);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 4000 });

    const slip = screen.getByLabelText('Slippage %');
    await userEvent.clear(slip);
    await userEvent.type(slip, '50');

    expect(await screen.findByText(/slippage must be in \(0, 10\]/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Close both/ })).toBeDisabled(),
    );
  });

  it('states that only the first leg carries the band', async () => {
    // The old copy promised "mark ± slippage" for the whole close, but the
    // hedge leg is deliberately a plain MARKET IOC (see decide.ts) — a
    // book-mid limit band gets price-limit-rejected and would strand it.
    server.use(...baseHandlers(), previewSpy([]));
    renderWithClient(<ClosePairForm base="HYPE" legs={LEGS} />);
    // The note rides as the tooltip on the "reduce-only IOC marketable limit"
    // affordance, so assert the title rather than visible text.
    const badge = await screen.findByText(/reduce-only IOC marketable limit/);
    expect(badge).toHaveAttribute(
      'title',
      expect.stringContaining("the hedge leg is sent at market, inside the venue's own price band"),
    );
  });
});
