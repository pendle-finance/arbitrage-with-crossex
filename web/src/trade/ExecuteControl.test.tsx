import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { ActionInput, DealRequest } from '../api/types';
import { account, baseHandlers, echoPreviewHandler, ethPosition, previewFor } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { ExecuteControl } from './ExecuteControl';

/** A ticket-like host whose qty-carrying action can be edited via a button. */
function EditableHost({ debounceMs = 20 }: { debounceMs?: number }) {
  const [qty, setQty] = useState('1');
  const action: ActionInput = { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', qty };
  return (
    <>
      <button type="button" onClick={() => setQty('2')}>
        bump
      </button>
      <ExecuteControl scope="host" actions={[action]} label="Go" holdMs={50} previewOpts={{ debounceMs }} />
    </>
  );
}

/** POST /api/deals handler that records bodies. `fail` returns an error
 * envelope (the client keys off the envelope's `ok`, not the HTTP status). */
function dealHandler(calls: DealRequest[], fail = false) {
  return http.post('/api/deals', async ({ request }) => {
    calls.push((await request.json()) as DealRequest);
    if (fail) {
      return HttpResponse.json(
        { ok: false, error: { category: 'network', message: 'boom', retryable: true } },
        { status: 500 },
      );
    }
    return HttpResponse.json(env({ id: calls[calls.length - 1].id }), { status: 202 });
  });
}

const notionalAction: ActionInput = {
  kind: 'open-market',
  symbol: 'GATE_FUTURE_ETH_USDT',
  side: 'BUY',
  notional: '1000',
};

/** Hold the confirm button until the 50ms gate fires. */
async function hold(name = 'Execute') {
  const btn = await screen.findByRole('button', { name });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.pointerDown(btn);
  return btn;
}

describe('ExecuteControl', () => {
  it('maps the confirmed intent onto a taker deal with the resolver-stamped qty', async () => {
    const calls: DealRequest[] = [];
    server.use(...baseHandlers(), echoPreviewHandler({ overrides: { qty: '0.4' } }), dealHandler(calls));
    renderWithClient(
      <ExecuteControl scope="t" actions={[notionalAction]} label="Execute" holdMs={50} />,
    );

    await hold();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      a: { symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY' },
      qty: '0.4', // the preview's resolved qty, never the raw notional
      execution: 'taker',
    });
    expect(calls[0].b ?? null).toBeNull();
  });

  it('a decorated maker intent (pegToTouch) maps to pricePolicy "touch"', async () => {
    const calls: DealRequest[] = [];
    const makerAction: ActionInput = {
      kind: 'open-limit',
      symbol: 'GATE_FUTURE_ETH_USDT',
      side: 'BUY',
      notional: '1000',
      price: '2500',
      tif: 'POC',
    };
    server.use(...baseHandlers(), echoPreviewHandler({ overrides: { qty: '0.4' } }), dealHandler(calls));
    renderWithClient(
      <ExecuteControl
        scope="t"
        actions={[makerAction]}
        label="Execute"
        holdMs={50}
        decorate={(a) => a.map((x) => ({ ...x, pegToTouch: true }) as ActionInput)}
      />,
    );

    await hold();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ execution: 'maker', price: '2500', qty: '0.4' });
  });

  it('reuses the SAME deal id across an error-retry (idempotent resend)', async () => {
    const calls: DealRequest[] = [];
    server.use(...baseHandlers(), echoPreviewHandler({ overrides: { qty: '0.4' } }), dealHandler(calls, true));
    renderWithClient(<ExecuteControl scope="t" actions={[notionalAction]} label="Execute" holdMs={50} />);

    await hold();
    await waitFor(() => expect(calls).toHaveLength(1));
    // The 500 leaves the id armed — a retry must reuse it so the server's
    // dedupe makes a lost-response resend a no-op.
    await hold();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].id).toBe(calls[0].id);
  });

  it('a fresh (non-error) confirm mints a NEW deal id', async () => {
    const calls: DealRequest[] = [];
    server.use(...baseHandlers(), echoPreviewHandler({ overrides: { qty: '0.4' } }), dealHandler(calls));
    renderWithClient(<ExecuteControl scope="t" actions={[notionalAction]} label="Execute" holdMs={50} />);

    await hold();
    await waitFor(() => expect(calls).toHaveLength(1));
    // A 202 clears the id; the next confirm is a new intent.
    await hold();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].id).not.toBe(calls[0].id);
  });

  it('is disabled (never POSTs) while the preview reports a violation', async () => {
    const calls: DealRequest[] = [];
    server.use(
      ...baseHandlers(),
      echoPreviewHandler({ overrides: { qty: '', violations: [{ code: 'below-min-notional', message: 'too small' }] } }),
      dealHandler(calls),
    );
    renderWithClient(<ExecuteControl scope="t" actions={[notionalAction]} label="Execute" holdMs={50} />);

    const btn = await screen.findByRole('button', { name: 'Execute' });
    await waitFor(() => expect(btn).toBeDisabled());
    fireEvent.pointerDown(btn);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toHaveLength(0);
  });

  it('a null-actions control renders disabled with no preview', () => {
    server.use(...baseHandlers());
    renderWithClient(<ExecuteControl scope="t" actions={null} label="Execute" holdMs={50} />);
    expect(screen.getByRole('button', { name: 'Execute' })).toBeDisabled();
  });

  it('never posts from a STALE preview: an edited input stays disabled until re-priced', async () => {
    const calls: DealRequest[] = [];
    let n = 0;
    server.use(
      ...baseHandlers(),
      http.post('/api/preview', async ({ request }) => {
        const { actions } = (await request.json()) as { actions: ActionInput[] };
        n += 1;
        if (n >= 2) await new Promise(() => {}); // the SECOND fetch hangs → estimating stays true
        return HttpResponse.json(env({ previews: actions.map((a, i) => previewFor(a, { index: i, qty: '0.4' })) }));
      }),
      dealHandler(calls),
    );
    renderWithClient(<EditableHost />);

    await waitFor(() => expect(n).toBeGreaterThanOrEqual(1)); // first preview (qty '1') settles
    await new Promise((r) => setTimeout(r, 120));
    fireEvent.click(screen.getByText('bump')); // edit to qty '2' — its preview hangs → stale
    const go = screen.getByRole('button', { name: 'Go' });
    // Every deal shape maps from the CURRENT preview, so a stale/estimating
    // preview must DISABLE confirm — posting the old preview's qty for the new
    // intent would trade the wrong size.
    await waitFor(() => expect(go).toBeDisabled(), { timeout: 2_000 });
    fireEvent.pointerDown(go);
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toHaveLength(0);
  });

  it('a STABLE intentKey retains the deal id even as actions self-mutate (maker-track double-execute guard)', async () => {
    const calls: DealRequest[] = [];
    server.use(...baseHandlers(), echoPreviewHandler({ overrides: { qty: '0.4' } }), dealHandler(calls, true));
    // The maker price auto-tracking the touch changes `actions` on its own; the
    // ticket passes a stable intentKey so a same-intent retry reuses the id.
    function TrackingHost() {
      const [px, setPx] = useState('100');
      const action: ActionInput = {
        kind: 'open-limit',
        symbol: 'GATE_FUTURE_ETH_USDT',
        side: 'BUY',
        qty: '0.4',
        price: px,
        tif: 'POC',
      };
      return (
        <>
          <button type="button" onClick={() => setPx('101')}>
            tick
          </button>
          <ExecuteControl scope="tr" actions={[action]} label="Go" holdMs={50} intentKey="pair|GATE|OKX|track" />
        </>
      );
    }
    renderWithClient(<TrackingHost />);

    const go = () => screen.getByRole('button', { name: 'Go' });
    await waitFor(() => expect(go()).toBeEnabled());
    fireEvent.pointerDown(go());
    await waitFor(() => expect(calls).toHaveLength(1)); // lost-response error → id retained
    fireEvent.click(screen.getByText('tick')); // price auto-ticks (NOT a user edit)
    await waitFor(() => expect(go()).toBeEnabled(), { timeout: 2_000 });
    fireEvent.pointerDown(go());
    await waitFor(() => expect(calls).toHaveLength(2), { timeout: 2_000 });
    // Same intent → SAME id → the server dedupes the resend (no double-execute).
    expect(calls[1].id).toBe(calls[0].id);
  });

  // The id lived only in a component ref, so ANY unmount between a lost-response
  // POST and the retry minted a fresh uuid the server could not dedupe — and a
  // second full-size deal was created. The Single/Pair toggle unmounts this
  // component outright, and a reload does the same, so this was one click away.
  it('reuses the deal id across a full remount after a lost response', async () => {
    const calls: DealRequest[] = [];
    server.use(...baseHandlers(), echoPreviewHandler({ overrides: { qty: '0.4' } }), dealHandler(calls, true));

    function RemountHost() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown((v) => !v)}>
            toggle
          </button>
          {shown && (
            <ExecuteControl scope="rm" actions={[notionalAction]} label="Go" holdMs={50} intentKey="pair|stable" />
          )}
        </>
      );
    }
    renderWithClient(<RemountHost />);

    const go = () => screen.getByRole('button', { name: 'Go' });
    await waitFor(() => expect(go()).toBeEnabled());
    fireEvent.pointerDown(go());
    await waitFor(() => expect(calls).toHaveLength(1)); // response lost → id must survive

    // Unmount and remount the control (exactly what the Single/Pair toggle does).
    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Go' })).toBeNull());
    fireEvent.click(screen.getByText('toggle'));

    await waitFor(() => expect(go()).toBeEnabled(), { timeout: 2_000 });
    fireEvent.pointerDown(go());
    await waitFor(() => expect(calls).toHaveLength(2), { timeout: 2_000 });
    expect(calls[1].id).toBe(calls[0].id); // deduped, NOT a second deal
  });

  it('mints a fresh id once the deal actually succeeded', async () => {
    const calls: DealRequest[] = [];
    server.use(...baseHandlers(), echoPreviewHandler({ overrides: { qty: '0.4' } }), dealHandler(calls));
    const { unmount } = renderWithClient(
      <ExecuteControl scope="ok1" actions={[notionalAction]} label="Go" holdMs={50} intentKey="pair|stable" />,
    );
    const go = () => screen.getByRole('button', { name: 'Go' });
    await waitFor(() => expect(go()).toBeEnabled());
    fireEvent.pointerDown(go());
    await waitFor(() => expect(calls).toHaveLength(1));
    unmount();

    renderWithClient(
      <ExecuteControl scope="ok2" actions={[notionalAction]} label="Go" holdMs={50} intentKey="pair|stable" />,
    );
    await waitFor(() => expect(go()).toBeEnabled(), { timeout: 2_000 });
    fireEvent.pointerDown(go());
    await waitFor(() => expect(calls).toHaveLength(2), { timeout: 2_000 });
    // The first deal EXISTS on the server; resending its id would reopen it.
    expect(calls[1].id).not.toBe(calls[0].id);
  });

  // The pending-basket store used to be ONE global slot, and every instance's
  // onSuccess cleared it unconditionally — so succeeding ANY other ticket
  // between a lost response and its retry destroyed the pending id, and the
  // retried ticket (after a remount) minted a fresh id the server could not
  // dedupe: a second full deal. The store is now a per-intent map and success
  // clears only its OWN entry; this pins exactly that.
  it("another intent's success does NOT erase a different intent's pending id", async () => {
    const calls: DealRequest[] = [];
    server.use(
      ...baseHandlers(),
      echoPreviewHandler({ overrides: { qty: '0.4' } }),
      // Ticket A (ETH) loses its response; ticket B (BTC) succeeds normally.
      http.post('/api/deals', async ({ request }) => {
        const body = (await request.json()) as DealRequest;
        calls.push(body);
        if (body.a.symbol === 'GATE_FUTURE_ETH_USDT') {
          return HttpResponse.json(
            { ok: false, error: { category: 'network', message: 'boom', retryable: true } },
            { status: 500 },
          );
        }
        return HttpResponse.json(env({ id: body.id }), { status: 202 });
      }),
    );

    const btcAction: ActionInput = {
      kind: 'open-market',
      symbol: 'BINANCE_FUTURE_BTC_USDT',
      side: 'SELL',
      notional: '500',
    };
    function TwoTicketHost() {
      const [shownA, setShownA] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShownA((v) => !v)}>
            toggleA
          </button>
          {shownA && (
            <ExecuteControl scope="ta" actions={[notionalAction]} label="GoA" holdMs={50} intentKey="intent|A" />
          )}
          <ExecuteControl scope="tb" actions={[btcAction]} label="GoB" holdMs={50} intentKey="intent|B" />
        </>
      );
    }
    renderWithClient(<TwoTicketHost />);

    // A submits and loses the response — its id is now pending under intent|A.
    await hold('GoA');
    await waitFor(() => expect(calls).toHaveLength(1));

    // B succeeds — pre-fix this wiped the ONE global slot, killing A's id.
    await hold('GoB');
    await waitFor(() => expect(calls).toHaveLength(2));

    // Remount A (so only the persisted store can supply the id) and retry.
    fireEvent.click(screen.getByText('toggleA'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'GoA' })).toBeNull());
    fireEvent.click(screen.getByText('toggleA'));
    const goA = () => screen.getByRole('button', { name: 'GoA' });
    await waitFor(() => expect(goA()).toBeEnabled(), { timeout: 2_000 });
    fireEvent.pointerDown(goA());
    await waitFor(() => expect(calls).toHaveLength(3), { timeout: 2_000 });
    // A's retry resends A's ORIGINAL id — the server dedupes, no second deal.
    expect(calls[2].id).toBe(calls[0].id);
    // And B's success cleared only B: its next confirm would be a fresh intent
    // (its entry is gone), while A's stayed. Sanity: B's id differs from A's.
    expect(calls[1].id).not.toBe(calls[0].id);
  });

  it('mints a FRESH deal id when the intent is edited after an error (no wrong-deal dedupe)', async () => {
    const calls: DealRequest[] = [];
    server.use(...baseHandlers(), echoPreviewHandler({ overrides: { qty: '0.4' } }), dealHandler(calls, true));
    renderWithClient(<EditableHost debounceMs={20} />);

    const go = () => screen.getByRole('button', { name: 'Go' });
    await waitFor(() => expect(go()).toBeEnabled());
    fireEvent.pointerDown(go());
    await waitFor(() => expect(calls).toHaveLength(1)); // 500 error → id retained
    fireEvent.click(screen.getByText('bump')); // EDIT the intent (qty 1 → 2)
    await waitFor(() => expect(go()).toBeEnabled(), { timeout: 2_000 }); // new preview settles
    fireEvent.pointerDown(go());
    await waitFor(() => expect(calls).toHaveLength(2), { timeout: 2_000 });
    // A changed intent must NOT reuse the errored id (the server would dedupe it
    // and surface the ORIGINAL deal) — it mints a fresh one.
    expect(calls[1].id).not.toBe(calls[0].id);
  });

  describe('margin blocking (H7)', () => {
    it('disables execute and shows a reason when required margin exceeds available', async () => {
      // account.availableMargin = 4200; 100000 / 10x = 10000 required, confident (leverage known).
      const calls: DealRequest[] = [];
      server.use(
        ...baseHandlers(),
        echoPreviewHandler({ overrides: { estNotional: 100_000, leverage: { requested: 10, max: 50 } } }),
        dealHandler(calls),
      );
      renderWithClient(<ExecuteControl scope="mb" actions={[notionalAction]} label="Execute" holdMs={50} />);

      const btn = await screen.findByRole('button', { name: 'Execute' });
      await waitFor(() => expect(btn).toBeDisabled());
      expect(await screen.findByRole('alert')).toHaveTextContent(/margin/i);
      fireEvent.pointerDown(btn);
      await new Promise((r) => setTimeout(r, 80));
      expect(calls).toHaveLength(0); // never posts
    });

    it('never blocks a close (reduce-only) even with a huge notional and tiny balance', async () => {
      const calls: DealRequest[] = [];
      const closeAction: ActionInput = { kind: 'close-position', symbol: 'GATE_FUTURE_ETH_USDT' };
      server.use(
        ...baseHandlers(),
        echoPreviewHandler({ overrides: { estNotional: 100_000 } }), // previewFor marks a close reduceOnly
        dealHandler(calls),
      );
      renderWithClient(<ExecuteControl scope="mc" actions={[closeAction]} label="Close" holdMs={50} />);

      const btn = await screen.findByRole('button', { name: 'Close' });
      await waitFor(() => expect(btn).toBeEnabled());
      fireEvent.pointerDown(btn);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({
        a: { reduceOnly: true, side: 'SELL' },
        execution: 'taker',
        clipBandPct: 0.5,
      });
    });

    it('never blocks a close when availableMargin is NEGATIVE (borrowing sub-account)', async () => {
      // A close requires 0, and 0 > -3870 is true — that disabled the one control that
      // could fix the account.
      const calls: DealRequest[] = [];
      const closeAction: ActionInput = { kind: 'close-position', symbol: 'GATE_FUTURE_ETH_USDT' };
      server.use(
        // FIRST match wins within one server.use — the override must precede baseHandlers'
        // own /api/account or the fixture's positive balance silently stands.
        http.get('/api/account', () =>
          HttpResponse.json(env({ ...account, availableMargin: '-3870.72', marginBalance: '4040.86', initialMargin: '7857.62' })),
        ),
        ...baseHandlers(),
        echoPreviewHandler({ overrides: { estNotional: 36_080 } }),
        dealHandler(calls),
      );
      renderWithClient(<ExecuteControl scope="mn" actions={[closeAction]} label="Close now" holdMs={50} />);

      const btn = await screen.findByRole('button', { name: 'Close now' });
      await waitFor(() => expect(btn).toBeEnabled());
      expect(screen.queryByText(/exceeds available/)).toBeNull();
      fireEvent.pointerDown(btn);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({ a: { reduceOnly: true }, execution: 'taker' });
    });

    // Two ORDINARY open-market legs (the pair ticket has no reduce-only mode), each
    // opposing a live position — together they open nothing.
    const UNWIND: ActionInput[] = [
      { kind: 'open-market', symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', side: 'BUY', qty: '1', leverage: 25 },
      { kind: 'open-market', symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'SELL', qty: '1', leverage: 25 },
    ];
    const BOOK = [
      { ...ethPosition, symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', positionQty: '-25.25', leverage: '25' },
      { ...ethPosition, symbol: 'BINANCE_FUTURE_ETH_USDT', positionQty: '10.579', leverage: '25' },
    ];
    /** Underwater account + a live book; `positions: null` leaves the read failing. */
    const underwater = (positions: unknown[] | null, positionMode = 'ONE_WAY') => [
      http.get('/api/account', () =>
        HttpResponse.json(env({ ...account, availableMargin: '-3824.76', positionMode })),
      ),
      http.get('/api/positions', () =>
        positions ? HttpResponse.json(env({ positions, exposure: [] })) : HttpResponse.error(),
      ),
      ...baseHandlers(),
      echoPreviewHandler({ overrides: { qty: '1', estNotional: 2457.8, leverage: { requested: 25, max: 25 } } }),
    ];

    it('nets an OPEN leg against the live opposite position (pair-ticket unwind)', async () => {
      server.use(...underwater(BOOK));
      renderWithClient(<ExecuteControl scope="mo" actions={UNWIND} label="Execute pair" holdMs={50} />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Execute pair' })).toBeEnabled());
      expect(screen.queryByText(/exceeds available/)).toBeNull();
    });

    it('does not block while positions are still loading', async () => {
      // The legs carry a requested leverage, so without the guard the estimate is
      // "confident" and full-priced — a false block until the 4s poll lands.
      server.use(...underwater(null));
      renderWithClient(<ExecuteControl scope="ml" actions={UNWIND} label="Execute pair" holdMs={50} />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Execute pair' })).toBeEnabled());
      expect(screen.queryByText(/exceeds available/)).toBeNull();
    });

    it('does NOT net in dual-side (hedge) mode — the same unwind stays blocked', async () => {
      // There a BUY against a short opens a SEPARATE long at full IM.
      server.use(...underwater(BOOK, 'DUAL_SIDE'));
      renderWithClient(<ExecuteControl scope="mh" actions={UNWIND} label="Execute pair" holdMs={50} />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Execute pair' })).toBeDisabled());
      expect(await screen.findByRole('alert')).toHaveTextContent(/exceeds available/);
    });

    it('still blocks an ALIGNED open that adds to an existing position', async () => {
      const add: ActionInput[] = [{ kind: 'open-market', symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'BUY', qty: '1', leverage: 25 }];
      server.use(...underwater(BOOK));
      renderWithClient(<ExecuteControl scope="mp" actions={add} label="Add" holdMs={50} />);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled());
      expect(await screen.findByRole('alert')).toHaveTextContent(/exceeds available/);
    });

    it('does not block a low-confidence estimate (no known leverage) — display only', async () => {
      const calls: DealRequest[] = [];
      server.use(
        ...baseHandlers(),
        echoPreviewHandler({ overrides: { estNotional: 100_000, leverage: undefined } }),
        dealHandler(calls),
      );
      renderWithClient(<ExecuteControl scope="ml" actions={[notionalAction]} label="Execute" holdMs={50} />);

      const btn = await screen.findByRole('button', { name: 'Execute' });
      await waitFor(() => expect(btn).toBeEnabled());
      fireEvent.pointerDown(btn);
      await waitFor(() => expect(calls).toHaveLength(1));
    });
  });
});

describe('a single resting limit order is a plain order', () => {
  /** One open-limit leg: no hedge, no deadline — it just rests. */
  const limitAction: ActionInput = {
    kind: 'open-limit',
    symbol: 'GATE_FUTURE_ETH_USDT',
    side: 'BUY',
    qty: '1',
    price: '2400',
    tif: 'POC',
  };

  it('confirms inline instead of dragging the user into the deal view', async () => {
    const calls: DealRequest[] = [];
    server.use(
      ...baseHandlers(),
      echoPreviewHandler({ overrides: { price: '2400', type: 'LIMIT', tif: 'POC' } }),
      dealHandler(calls),
    );
    renderWithClient(
      <ExecuteControl scope="limit" actions={[limitAction]} label="Go" holdMs={50} intentKey="limit|1" />,
    );

    const go = () => screen.getByRole('button', { name: 'Go' });
    await waitFor(() => expect(go()).toBeEnabled());
    fireEvent.pointerDown(go());

    // It really was sent as a single resting maker deal...
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].b ?? null).toBeNull();
    expect(calls[0].execution).toBe('maker');

    // ...and the answer is a confirmation, not a deal modal.
    expect(await screen.findByText(/Limit order placed/)).toBeInTheDocument();
    expect(screen.getByText(/BUY 0.05 ETH @ 2400/)).toBeInTheDocument(); // a receipt, not just "ok"
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the receipt SURVIVES the ticket clearing itself', async () => {
    // The real ticket calls onExecuted -> clearTicket on success, which changes
    // the intent in the same cycle the receipt is set. Clearing the receipt on
    // intent change wiped it instantly, so nothing ever confirmed the order.
    const calls: DealRequest[] = [];
    server.use(
      ...baseHandlers(),
      echoPreviewHandler({ overrides: { price: '2400', type: 'LIMIT', tif: 'POC' } }),
      dealHandler(calls),
    );

    function ClearingHost() {
      const [qty, setQty] = useState('1');
      const action: ActionInput = {
        kind: 'open-limit',
        symbol: 'GATE_FUTURE_ETH_USDT',
        side: 'BUY',
        qty,
        price: '2400',
        tif: 'POC',
      };
      return (
        <ExecuteControl
          scope="clearing"
          actions={qty ? [action] : null}
          label="Go"
          holdMs={50}
          onExecuted={() => setQty('')}
        />
      );
    }
    renderWithClient(<ClearingHost />);

    const go = () => screen.getByRole('button', { name: 'Go' });
    await waitFor(() => expect(go()).toBeEnabled());
    fireEvent.pointerDown(go());
    await waitFor(() => expect(calls).toHaveLength(1));

    const receipt = await screen.findByText(/Limit order placed/);
    // Still there after the ticket has reset around it.
    await new Promise((r) => setTimeout(r, 60));
    expect(receipt).toBeInTheDocument();
  });

  it('a hedged pair still opens the deal view', async () => {
    const calls: DealRequest[] = [];
    server.use(
      ...baseHandlers(),
      echoPreviewHandler({ overrides: { qty: '1' } }),
      dealHandler(calls),
    );
    const pair: ActionInput[] = [
      { kind: 'open-market', symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', qty: '1' },
      { kind: 'open-market', symbol: 'BINANCE_FUTURE_ETH_USDT', side: 'SELL', qty: '1' },
    ];
    renderWithClient(
      <ExecuteControl scope="pair2" actions={pair} label="Go" holdMs={50} intentKey="pair|1" />,
    );
    const go = () => screen.getByRole('button', { name: 'Go' });
    await waitFor(() => expect(go()).toBeEnabled());
    fireEvent.pointerDown(go());

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].b).not.toBeNull();
    // No "placed" confirmation for a real deal — that one is supervised.
    await waitFor(() => expect(screen.queryByText(/Limit order placed/)).toBeNull());
  });
});
