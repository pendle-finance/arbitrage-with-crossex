import { describe, expect, it } from 'vitest';
import { BOROS_API_BASE, makeBorosApiOrderClient, type ApiFetch } from '../../src/core/boros/borosApi';
import { norm18 } from '../../src/core/boros/client';
import { reducingOrderSize } from '../../src/core/boros/pair';

const HL = 155;
const WEI = 10n ** 18n;
const MICRO = 10n ** 12n;
const RUNGS = [50, 5_000, 100_000, 1_000_000, 6_000_000];
const OPEN_OFFSETS = [-MICRO, -1n, 1n, MICRO];

function relayCapture() {
  const sizes: string[] = [];
  const fetchImpl: ApiFetch = async (url, init) => {
    const path = url.replace(BOROS_API_BASE, '');
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (path.startsWith('/v1/accounts/entered-markets')) return ok({ results: [{ marketId: HL, isMatured: false }] });
    if (path.startsWith('/v1/calldata-builder/agent/enter-markets')) return ok({ calls: [{ calldata: '0xe0' }] });
    if (path.startsWith('/v1/calldata-builder/agent/place-order')) {
      sizes.push(String(body.size));
      return ok({ calls: [{ calldata: '0xda' }] });
    }
    if (path.startsWith('/v1/send-txs/bulk-calls')) {
      const datas = body.datas as unknown[];
      return ok(datas.map((_, index) => ({ txHash: '0xtx', index, status: 'success' })));
    }
    if (path.startsWith('/v1/send-txs/tx-status-with-events')) return ok({ status: 'success', statuses: [] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = makeBorosApiOrderClient({
    root: '0x9dcf85824e024fea9e3ef583dccbea68edbc37b8',
    accountId: 0,
    agentPrivateKey: `0x${'11'.repeat(32)}`,
    tokenIdForMarket: () => 3,
    fetchImpl,
    statusAttempts: 1,
    sleep: async () => {},
  });
  return { sizes, client };
}

const cases = RUNGS.flatMap((rung) =>
  OPEN_OFFSETS.map((offset) => {
    const openWei = BigInt(rung) * WEI + offset;
    const openSize = Math.abs(norm18(openWei.toString()));
    return { rung, hair: offset.toString(), openWei, openSize, requests: [openSize, openSize + 1e-6, openSize - 1e-6, openSize * 10] };
  }),
);

const expectWithinOpen = (wire: string | undefined, openWei: bigint) => {
  expect(wire).toMatch(/^\d+$/);
  expect(BigInt(wire!) <= openWei).toBe(true);
};

describe('close sizing from $50 to $6,000,000', () => {
  it.each(cases)('a pair close leg never sends past the open size, rung $rung, hair $hair wei', async ({ openWei, openSize, requests }) => {
    for (const requested of requests) {
      const { size, sizeWei } = reducingOrderSize(openWei.toString(), requested);
      expect(size).toBeLessThanOrEqual(openSize);
      const { sizes, client } = relayCapture();
      await client.placeMarketOrders(
        [
          {
            marketId: HL,
            direction: 'short',
            size,
            limitApr: 0.08,
            clientOrderId: 'scale-pair-1',
            ...(sizeWei !== undefined ? { sizeWei } : {}),
          },
        ],
        { reducing: true },
      );
      expect(sizes).toHaveLength(1);
      expectWithinOpen(sizes[0], openWei);
    }
  });

  it.each(cases)('a single close never sends past the open size, rung $rung, hair $hair wei', async ({ openWei, openSize, requests }) => {
    for (const requested of requests) {
      const { size } = reducingOrderSize(openWei.toString(), requested);
      expect(size).toBeLessThanOrEqual(openSize);
      const { sizes, client } = relayCapture();
      await client.closePosition({
        marketId: HL,
        size,
        openSizeWei: openWei.toString(),
        direction: 'short',
        limitApr: 0.08,
        clientOrderId: 'scale-close-1',
      });
      expect(sizes).toHaveLength(1);
      expectWithinOpen(sizes[0], openWei);
    }
  });

  it('caps a $6,000,000 close one wei under the step at the venue integer', () => {
    const openWei = 6_000_000n * WEI - 1n;
    const { sizeWei } = reducingOrderSize(openWei.toString(), 6_000_000);
    expect(sizeWei).toBe(openWei.toString());
  });

  it('reads a short position by its size, not its sign', () => {
    const { size, sizeWei } = reducingOrderSize((-(100_000n * WEI)).toString(), 250_000);
    expect(size).toBeCloseTo(100_000, 6);
    expect(size).toBeLessThanOrEqual(100_000);
    expect(sizeWei).toBeUndefined();
  });
});
