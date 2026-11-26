import { describe, expect, it } from 'vitest';
import type { ResolvedAction } from '../../src/core/actions';
import type { Clients } from '../../src/core/clients';
import { preflightMargin } from '../../src/core/preflight';

const SYM = 'GATE_FUTURE_ETH_USDT';
const PX = 2500;
const clients = {} as Clients;

function leg(over: Partial<ResolvedAction>): ResolvedAction {
  return {
    index: 0,
    input: { kind: 'open-market', symbol: SYM, side: 'BUY' } as ResolvedAction['input'],
    symbol: SYM,
    side: 'BUY',
    type: 'MARKET',
    tif: 'IOC',
    reduceOnly: false,
    qty: '1',
    estNotional: 0,
    violations: [],
    warnings: [],
    ...over,
  };
}

const realize = (notional: number) => [
  leg({ index: 0, side: 'SELL', reduceOnly: true, type: 'LIMIT', tif: 'GTC', qty: String(notional / PX), estNotional: notional }),
  leg({ index: 1, side: 'BUY', qty: String(notional / PX), estNotional: notional, leverage: { requested: 25, max: 25 } }),
];

const account = (availableMargin: string, positionMode = 'SINGLE') =>
  async () => ({ availableMargin, positionMode }) as Awaited<ReturnType<NonNullable<Parameters<typeof preflightMargin>[2]>['getAccount'] & object>>;

describe('preflightMargin credits no close it cannot see', () => {
  it.each([50, 6_000_000])('a failed positions read charges the %d dollar reopen in full', async (notional) => {
    const free = String((notional / 25) * 0.75);
    await expect(
      preflightMargin(clients, realize(notional), {
        getAccount: account(free),
        getPositions: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toMatchObject({ category: 'insufficient-margin' });
  });

  it('an account not in one-way mode charges the reopen in full', async () => {
    await expect(
      preflightMargin(clients, realize(100_000), { getAccount: account('3000', 'DUAL') }),
    ).rejects.toMatchObject({ category: 'insufficient-margin' });
  });

  it('a read that shows the position still credits the close', async () => {
    await expect(
      preflightMargin(clients, realize(6_000_000), {
        getAccount: account(String((6_000_000 / 25) * 0.75)),
        getPositions: async () => [{ symbol: SYM, positionQty: String(6_000_000 / PX) }],
      }),
    ).resolves.toBeUndefined();
  });
});
