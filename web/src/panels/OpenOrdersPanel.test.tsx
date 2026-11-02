import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { OpenOrder } from '../api/types';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { OpenOrdersPanel } from './OpenOrdersPanel';

const order: OpenOrder = {
  orderId: '424242',
  text: 'web_abc_0',
  state: 'WEIRD_STATE_42',
  symbol: 'GATE_FUTURE_ETH_USDT',
  side: 'BUY',
  type: 'LIMIT',
  timeInForce: 'GTC',
  qty: '1',
  price: '2500',
  executedQty: '0',
  executedAvgPrice: '',
  reduceOnly: false,
  createTime: 1_751_500_000,
};

describe('OpenOrdersPanel', () => {
  it('renders an unknown state verbatim in a neutral chip (never crashes)', async () => {
    server.use(http.get('/api/orders/open', () => HttpResponse.json(env([order]))));
    renderWithClient(<OpenOrdersPanel />);

    const chip = await screen.findByText('WEIRD_STATE_42');
    expect(chip).toBeInTheDocument();
    expect(chip.className).toContain('chip');
    // Neutral — none of the toned colors.
    for (const toned of ['text-emerald-400', 'text-rose-400', 'text-amber-400', 'text-sky-400']) {
      expect(chip.className).not.toContain(toned);
    }
  });

  it('fires DELETE /api/orders/:id exactly once on Cancel', async () => {
    let deletes = 0;
    server.use(
      http.get('/api/orders/open', () => HttpResponse.json(env([order]))),
      http.delete('/api/orders/:id', ({ params }) => {
        deletes += 1;
        expect(params.id).toBe('424242');
        return HttpResponse.json(env({ orderId: '424242', canceled: true }));
      }),
    );
    renderWithClient(<OpenOrdersPanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(deletes).toBe(1));
    // The row stays marked "cancelling" while the venue still lists the order
    // (this fixture never drops it), and the re-checks that marking triggers
    // must not re-issue the DELETE.
    await new Promise((r) => setTimeout(r, 1_200)); // spans a re-check tick
    expect(deletes).toBe(1);
  });
});

describe('cancel feedback', () => {
  // A cancel is ACCEPTED in milliseconds but the order leaves the venue later
  // (for an engine-owned order, a loop tick later). The row used to sit there
  // looking untouched and then vanish, so nothing told the user it worked.
  it('marks the row cancelling until the order actually goes', async () => {
    let cancelled = false;
    server.use(
      // The venue keeps reporting the order until the cancel lands.
      http.get('/api/orders/open', () => HttpResponse.json(env(cancelled ? [] : [order]))),
      http.delete('/api/orders/:id', () => {
        setTimeout(() => {
          cancelled = true;
        }, 150);
        return HttpResponse.json(env({ orderId: '424242', canceled: true }));
      }),
    );
    renderWithClient(<OpenOrdersPanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    // Still listed, but visibly in progress rather than looking untouched.
    expect(await screen.findAllByText('Cancelling…')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Cancelling/ })).toBeDisabled();

    // …and it clears on its own once the order is really gone.
    await waitFor(() => expect(screen.queryAllByText('Cancelling…')).toHaveLength(0), { timeout: 4000 });
  });

  it('explains when the order is owned by a deal', async () => {
    server.use(
      http.get('/api/orders/open', () => HttpResponse.json(env([order]))),
      // The engine path: the route stops the deal and the LOOP cancels.
      http.delete('/api/orders/:id', () =>
        HttpResponse.json(env({ id: '424242', dealId: 'deal-abc12345', cancelling: true })),
      ),
    );
    renderWithClient(<OpenOrdersPanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText(/belongs to a running deal/)).toBeInTheDocument();
    expect(screen.getByText(/clears once the venue confirms/)).toBeInTheDocument();
  });
});
