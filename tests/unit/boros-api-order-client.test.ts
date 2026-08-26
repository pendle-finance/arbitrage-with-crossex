/**
 * The direct-API Boros order client. What matters here is what actually
 * reaches the venue on the money path: an ATOMIC pair, the right account
 * charged, the rate bound the tolerance produced, and a fill decoded from the
 * call that emitted it.
 */
import { keccak256, verifyTypedData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  absWei,
  BOROS_API_BASE,
  CROSS_MARKET_ID,
  decimalString,
  makeBorosApiOrderClient,
  packAccount,
  packMarketAcc,
  type ApiFetch,
} from '../../src/core/boros/borosApi';
import type { BorosMarketOrderRequest } from '../../src/core/boros/orders';

const ROOT = '0x9dcf85824e024fea9e3ef583dccbea68edbc37b8' as const;
const AGENT_KEY = `0x${'11'.repeat(32)}` as const;
const HL = 155;
const BN = 158;

interface Call {
  path: string;
  body: Record<string, unknown>;
}

/** A fake Boros API. Records every call; answers the three endpoints the
 * client uses, with per-test overrides. */
function fakeApi(
  over: {
    status?: unknown;
    submit?: (body: Record<string, unknown>) => unknown;
    failEnter?: string;
    /** Raw body the ENTER submission answers with, for the shapes that are
     * neither a clean success nor a per-call error. */
    enterReturns?: unknown;
    /** Same, for the gas TOP-UP submission. */
    payReturns?: unknown;
    /** Raw body of the gas-balance read. */
    gasBalance?: unknown;
    /** marketIds the venue already considers entered, per read. Successive
     * entries let a test change the answer between reads. */
    enteredReads?: number[][];
  } = {},
) {
  const calls: Call[] = [];
  const reads = [...(over.enteredReads ?? [])];
  const fetchImpl: ApiFetch = async (url, init) => {
    const path = url.replace(BOROS_API_BASE, '');
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ path, body });
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });

    if (path.startsWith('/v1/accounts/entered-markets')) {
      const next = reads.length > 1 ? reads.shift()! : (reads[0] ?? []);
      return ok({ results: next.map((marketId) => ({ marketId, isMatured: false })) });
    }
    if (path.startsWith('/v1/calldata-builder/agent/enter-markets')) {
      return ok({ calls: [{ calldata: '0xe0' }] });
    }
    if (path.startsWith('/v1/calldata-builder/agent/place-order')) {
      return ok({ calls: [{ calldata: `0xda${calls.length.toString(16).padStart(2, '0')}` }] });
    }
    if (path.startsWith('/v1/calldata-builder/agent/cancel-orders')) {
      return ok({ calls: [{ calldata: '0xca' }] });
    }
    if (path.startsWith('/v1/calldata-builder/agent/pay-treasury')) {
      return ok({ calls: [{ calldata: '0x7a' }] });
    }
    if (path.startsWith('/v1/send-txs/bulk-calls')) {
      const datas = body.datas as Array<{ calldata: string }>;
      // The enter-markets submission is the one carrying 0xe0; overrides are
      // about the ORDER submission and must not leak onto it.
      if (datas[0]?.calldata === '0x7a') {
        if (over.payReturns !== undefined) return ok(over.payReturns);
        return ok(datas.map((_, i) => ({ txHash: '0xpay', index: i, status: 'success' })));
      }
      const isEnter = datas[0]?.calldata === '0xe0';
      if (isEnter) {
        if (over.enterReturns !== undefined) return ok(over.enterReturns);
        return ok(
          over.failEnter
            ? [{ error: over.failEnter }]
            : datas.map((_, i) => ({ txHash: '0xenter', index: i, status: 'success' })),
        );
      }
      if (over.submit) return ok(over.submit(body));
      return ok(datas.map((_, i) => ({ txHash: '0xtx', index: i, status: 'success' })));
    }
    if (path.startsWith('/v1/send-txs/tx-status-with-events')) {
      return ok(over.status ?? { status: 'success', statuses: [] });
    }
    if (path.startsWith('/v1/accounts/gas-balance')) {
      return ok(over.gasBalance === undefined ? { balanceInUSD: 42 } : over.gasBalance);
    }
    return { ok: false, status: 404, json: async () => ({ message: 'nope' }) };
  };
  return { calls, fetchImpl };
}

const client = (api: ReturnType<typeof fakeApi>) =>
  makeBorosApiOrderClient({
    root: ROOT,
    accountId: 0,
    agentPrivateKey: AGENT_KEY,
    // Both legs on ETH collateral: an eligible pair must share a token, which
    // is also what makes them one cross account.
    tokenIdForMarket: () => 2,
    fetchImpl: api.fetchImpl,
    statusAttempts: 1,
    sleep: async () => {},
  });

const leg = (over: Partial<BorosMarketOrderRequest> = {}): BorosMarketOrderRequest => ({
  marketId: HL,
  direction: 'short',
  size: 10,
  limitApr: 0.0875,
  clientOrderId: 'a-0000001',
  ...over,
});

/** One executed market order on `marketId`, filling `size` tokens. */
const filled = (marketId: number, size: string) => ({ marketId, size, side: 1 });

describe('packing', () => {
  it('packs a MarketAcc as root · accountId · tokenId · CROSS, not the traded market', () => {
    // Verified against the Boros UI's own request: marketAcc ends _00_0002_ffffff
    // with marketId=129 sent separately. Packing the traded marketId here
    // addresses a per-market account holding no cash, and the venue answers
    // "Top up at least ~$10 to trade" about an account the user cannot see.
    expect(packMarketAcc(ROOT, 0, 2, CROSS_MARKET_ID)).toBe(`${ROOT}000002ffffff`);
    expect(packMarketAcc(ROOT, 0, 2, CROSS_MARKET_ID)).toHaveLength(54);
  });

  it('packs an Account as root · accountId', () => {
    expect(packAccount(ROOT, 0)).toBe(`${ROOT}00`);
    expect(packAccount(ROOT, 7)).toBe(`${ROOT}07`);
    expect(packAccount(ROOT, 0)).toHaveLength(44);
  });

  it('keeps sizes positional — parseUnits rejects exponential notation', () => {
    expect(decimalString(1e-18)).toBe('0.000000000000000001');
    expect(decimalString(100_000)).toBe('100000');
    expect(() => decimalString(1e21)).toThrow(/out of range/);
    expect(() => decimalString(Number.NaN)).toThrow(/finite/);
  });
});

describe('makeBorosApiOrderClient — atomicity', () => {
  it('sends BOTH legs in one bulk-call with requireSuccess', async () => {
    const api = fakeApi();
    await client(api).placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]);

    const submits = api.calls.filter((c) => c.path === '/v1/send-txs/bulk-calls');
    // One submission (the enter-markets one, then the orders) — the orders go
    // together, never as two races against the signer's nonce.
    const orderSubmit = submits[submits.length - 1];
    expect((orderSubmit.body.datas as unknown[]).length).toBe(2);
    expect(orderSubmit.body.requireSuccess).toBe(true);
  });

  it('does not require success for a lone leg — there is nothing to be atomic with', async () => {
    const api = fakeApi();
    await client(api).placeMarketOrders([leg()]);
    const submits = api.calls.filter((c) => c.path === '/v1/send-txs/bulk-calls');
    expect(submits[submits.length - 1].body.requireSuccess).toBe(false);
  });

  it('reports EVERY leg failed when the batch reverts — the legs stood together', async () => {
    const api = fakeApi({ submit: () => [{ error: 'INSUFFICIENT_MARGIN' }] });
    const fills = await client(api).placeMarketOrders([
      leg(),
      leg({ marketId: BN, direction: 'long' }),
    ]);
    expect(fills).toHaveLength(2);
    for (const f of fills) {
      expect(f.filledSize).toBe(0);
      expect(f.failure?.code).toBe('insufficient-margin');
    }
  });

  it('signs each call with a strictly ascending nonce', async () => {
    const api = fakeApi();
    await client(api).placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]);
    const submit = api.calls.filter((c) => c.path === '/v1/send-txs/bulk-calls').pop()!;
    const datas = submit.body.datas as Array<{ message: { nonce: string; account: string } }>;
    // The endpoint rejects unsorted or reused nonces outright.
    expect(BigInt(datas[1].message.nonce)).toBeGreaterThan(BigInt(datas[0].message.nonce));
    expect(datas[0].message.account).toBe(packAccount(ROOT, 0));
  });
});

describe('makeBorosApiOrderClient — the agent signature', () => {
  it('signs a message that recovers to the agent address', async () => {
    // The one step no read-only probe can exercise: if the domain, the type
    // list or the message encoding is wrong, the venue rejects the batch and
    // nothing trades. Recovering the signer proves everything except that the
    // BACKEND agrees on the domain — and that is taken verbatim from the
    // router ABI and the SDK's own constants.
    const api = fakeApi();
    await client(api).placeMarketOrders([leg()]);
    const submit = api.calls.filter((c) => c.path === '/v1/send-txs/bulk-calls').pop()!;
    const data = (submit.body.datas as Array<{
      agent: Hex;
      signature: Hex;
      calldata: Hex;
      message: { account: Hex; connectionId: Hex; nonce: string };
    }>)[0];

    const ok = await verifyTypedData({
      address: privateKeyToAccount(AGENT_KEY).address,
      domain: {
        name: 'Pendle Boros Router',
        version: '1.0',
        chainId: 42161,
        verifyingContract: '0x8080808080daB95eFED788a9214e400ba552DEf6',
      },
      types: {
        PendleSignTx: [
          { name: 'account', type: 'bytes21' },
          { name: 'connectionId', type: 'bytes32' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      primaryType: 'PendleSignTx',
      message: { ...data.message, nonce: BigInt(data.message.nonce) },
      signature: data.signature,
    });
    expect(ok).toBe(true);
    expect(data.agent).toBe(privateKeyToAccount(AGENT_KEY).address);
    // The message binds the signature to THIS calldata: a swapped payload
    // would not verify against the same connectionId.
    expect(data.message.connectionId).toBe(keccak256(data.calldata));
  });
});

describe('makeBorosApiOrderClient — the order on the wire', () => {
  it('charges the CROSS account, trades the named market, and carries the rate bound', async () => {
    const api = fakeApi();
    await client(api).placeMarketOrders([leg({ direction: 'short', size: 10, limitApr: 0.0875 })]);
    const build = api.calls.find((c) => c.path === '/v1/calldata-builder/agent/place-order')!;
    expect(build.body).toMatchObject({
      // tokenId 2 for HL, marketId segment = CROSS.
      marketAcc: packMarketAcc(ROOT, 0, 2, CROSS_MARKET_ID),
      marketId: HL,
      side: 1, // SHORT
      size: '10000000000000000000',
      tif: 1, // IOC
      rate: 0.0875,
    });
    // `slippage` would make the backend derive its own guard from mid-rate,
    // silently replacing the bound the user's tolerance produced.
    expect(build.body).not.toHaveProperty('slippage');
  });

  it('maps a long leg to side 0', async () => {
    const api = fakeApi();
    await client(api).placeMarketOrders([leg({ marketId: BN, direction: 'long' })]);
    const build = api.calls.find((c) => c.path === '/v1/calldata-builder/agent/place-order')!;
    expect(build.body).toMatchObject({ side: 0, marketId: BN });
  });
});

describe('makeBorosApiOrderClient — fills', () => {
  it('reads each leg\'s fill from the call that emitted it', async () => {
    const api = fakeApi({
      status: {
        status: 'success',
        statuses: [
          { index: 0, status: 'success', marketOrdersExecuted: [filled(HL, '10000000000000000000')] },
          { index: 1, status: 'success', marketOrdersExecuted: [filled(BN, '4000000000000000000')] },
        ],
      },
    });
    const [a, b] = await client(api).placeMarketOrders([
      leg({ size: 10 }),
      leg({ marketId: BN, direction: 'long', size: 10 }),
    ]);
    expect(a.filledSize).toBeCloseTo(10, 9);
    expect(a.shortfallSize).toBe(0);
    expect(a.failure).toBeNull();
    // Leg B filled short — atomic does NOT mean fully filled: an IOC that
    // matches part of its size succeeds, it does not revert.
    expect(b.filledSize).toBeCloseTo(4, 9);
    expect(b.shortfallSize).toBeCloseTo(6, 9);
    expect(b.failure?.code).toBe('insufficient-depth');
  });

  it('treats a float-dust remainder as a full fill, not a phantom residual', async () => {
    // 18-dec sizes cannot round-trip through float64 exactly: a full 100,000
    // comes back as 99999.99999999999.
    const api = fakeApi({
      status: {
        statuses: [{ index: 0, marketOrdersExecuted: [filled(HL, '99999999999999990000')] }],
      },
    });
    const [f] = await client(api).placeMarketOrders([leg({ size: 100 })]);
    expect(f.shortfallSize).toBe(0);
    expect(f.failure).toBeNull();
  });

  it('never lends one leg another leg\'s fill', async () => {
    const api = fakeApi({
      status: {
        statuses: [
          { index: 0, marketOrdersExecuted: [filled(HL, '10000000000000000000'), filled(BN, '10000000000000000000')] },
          { index: 1, marketOrdersExecuted: [filled(BN, '10000000000000000000')] },
        ],
      },
    });
    const [a] = await client(api).placeMarketOrders([
      leg({ size: 10 }),
      leg({ marketId: BN, direction: 'long', size: 10 }),
    ]);
    // Only the HL row counts toward the HL leg, even though both were grouped
    // under call 0.
    expect(a.filledSize).toBeCloseTo(10, 9);
  });

  it('calls an unreadable status UNKNOWN, never a zero fill', async () => {
    const api = fakeApi({ status: { statuses: [] } });
    const [f] = await client(api).placeMarketOrders([leg()]);
    expect(f.failure?.code).toBe('unknown');
    expect(f.failure?.message).toMatch(/may or may not have filled/i);
  });
});

describe('makeBorosApiOrderClient — preconditions and remediation', () => {
  it('never re-enters a market the venue already entered', async () => {
    // The live failure: entering is permanent, so a fresh process that assumes
    // nothing is entered reverts the whole batch with
    // "[SIMULATE] MMMarketAlreadyEntered()" and no order is ever placed.
    const api = fakeApi({ enteredReads: [[HL, BN]] });
    await client(api).placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]);
    expect(api.calls.filter((c) => c.path.includes('/calldata-builder/agent/enter-markets'))).toHaveLength(0);
    // …and it asked, once, rather than guessing.
    expect(api.calls.filter((c) => c.path.startsWith('/v1/accounts/entered-markets'))).toHaveLength(1);
  });

  it('enters only the markets missing from the venue\'s list', async () => {
    const api = fakeApi({ enteredReads: [[HL]] });
    await client(api).placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]);
    const enter = api.calls.find((c) => c.path.includes('/calldata-builder/agent/enter-markets'))!;
    expect(enter.body.marketIds).toEqual([BN]);
  });

  it('re-reads and retries once when the venue says AlreadyEntered', async () => {
    // A stale cached view — another client entered the market since the read.
    // The call reverts wholesale, so markets that were genuinely missing are
    // still missing; re-reading is the only way to tell which.
    const api = fakeApi({
      enteredReads: [[], [HL, BN]],
      failEnter: '[SIMULATE] MMMarketAlreadyEntered()',
    });
    const fills = await client(api).placeMarketOrders([leg()]);
    // It recovered instead of failing the order.
    expect(fills[0].failure?.code).not.toBe('rejected');
    expect(api.calls.filter((c) => c.path.startsWith('/v1/accounts/entered-markets'))).toHaveLength(2);
    // And it did not loop: exactly one enter attempt before the re-read cleared it.
    expect(api.calls.filter((c) => c.path.includes('/calldata-builder/agent/enter-markets'))).toHaveLength(1);
  });

  it('enters every missing market in ONE call, then caches it', async () => {
    const api = fakeApi();
    const c = client(api);
    await c.placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]);
    const enters = api.calls.filter((x) => x.path === '/v1/calldata-builder/agent/enter-markets');
    expect(enters).toHaveLength(1);
    expect(enters[0].body).toMatchObject({ isCross: true, marketIds: [HL, BN] });

    await c.placeMarketOrders([leg()]);
    expect(api.calls.filter((x) => x.path.includes('enter-markets'))).toHaveLength(1);
  });

  it('does not cache a REFUSED market entry', async () => {
    // The submission resolves with a per-call error rather than throwing;
    // caching it as entered would reject every later order on this market with
    // the venue's misleading "top up" message until the process restarts.
    const api = fakeApi({ failEnter: 'GAS_BALANCE_TOO_LOW' });
    const c = client(api);
    await expect(c.placeMarketOrders([leg()])).rejects.toThrow(/refused to enter/i);
    await expect(c.placeMarketOrders([leg()])).rejects.toThrow(/refused to enter/i);
    expect(api.calls.filter((x) => x.path.includes('enter-markets'))).toHaveLength(2);
  });

  it('cancels every resting order on a market', async () => {
    const api = fakeApi();
    await client(api).cancelOrders(HL);
    const req = api.calls.find((c) => c.path.includes('cancel-orders'))!;
    expect((req.body.markets as Array<Record<string, unknown>>)[0]).toMatchObject({
      marketAcc: packMarketAcc(ROOT, 0, 2, CROSS_MARKET_ID),
      marketId: HL,
      cancelAll: true,
    });
  });

  it('reads the prepaid gas balance in USD', async () => {
    const api = fakeApi();
    expect(await client(api).getGasBalance?.()).toBe(42);
    expect(api.calls.some((c) => c.path.startsWith('/v1/accounts/gas-balance?root='))).toBe(true);
  });

  it('reports a balance it could not read as UNKNOWN, not as a funded account', async () => {
    // It used to answer POSITIVE_INFINITY, which every gas check downstream
    // read as an account rich enough to trade.
    expect(await client(fakeApi({ gasBalance: {} })).getGasBalance?.()).toBeNull();
    expect(await client(fakeApi({ gasBalance: null })).getGasBalance?.()).toBeNull();
  });
});

describe('makeBorosApiOrderClient — a result that says nothing is not a result', () => {
  it('refuses to cache a market entry whose submission returned no result', async () => {
    // `submitCalls` renders any non-array body as `[]`. Read as "submitted,
    // no per-call errors", that caches the market as entered and every later
    // order is refused by the venue with its misleading "top up ~$10" message
    // — for the life of the process, because the cache short-circuits.
    for (const body of [{}, null, { results: [] }, []]) {
      const api = fakeApi({ enterReturns: body });
      const c = client(api);
      await expect(c.placeMarketOrders([leg()])).rejects.toThrow(/no result for entering/i);
      // Nothing was cached: the next attempt tries to enter again.
      await expect(c.placeMarketOrders([leg()])).rejects.toThrow(/no result for entering/i);
      expect(api.calls.filter((x) => x.path.includes('enter-markets'))).toHaveLength(2);
    }
  });

  it('refuses to report a cancel whose submission returned no result', async () => {
    // A remediation path reporting a cancel that may never have been submitted
    // is the one answer it must not give.
    const api = fakeApi({ submit: () => ({}) });
    await expect(client(api).cancelOrders(HL)).rejects.toThrow(/no result for the cancel/i);
  });

  it('calls a leg with no status UNKNOWN, never a zero fill', async () => {
    // The venue answered for call 0 and said nothing about call 1. Reading the
    // silence as "nothing matched" tells the user a leg definitely did not
    // trade when it may have — and re-issuing on that doubles the position.
    const api = fakeApi({
      status: {
        status: 'success',
        statuses: [{ index: 0, status: 'success', marketOrdersExecuted: [filled(HL, '10000000000000000000')] }],
      },
    });
    const fills = await client(api).placeMarketOrders([
      leg(),
      leg({ marketId: BN, direction: 'long', clientOrderId: 'b-0000001' }),
    ]);
    expect(fills[0].filledSize).toBeCloseTo(10, 9);
    expect(fills[0].failure).toBeNull();

    expect(fills[1].failure?.code).toBe('unknown');
    expect(fills[1].failure?.message).toMatch(/may or may not have filled/i);
    expect(fills[1].failure?.message).not.toMatch(/nothing matched/i);
  });
});

/**
 * A CLOSE MAY NEVER PLACE MORE THAN IS OPEN.
 *
 * Boros has no reduce-only flag, so nothing at the venue stops a close at
 * flat: one unit too many crosses it and opens a fresh position the other way.
 * The route clamps the size to what is open, but it clamps two DOUBLES, and
 * the order is not built from a double — `parseUnits` of `50000000000000000 /
 * 1e18` is 50000000000000003. Three units of an opposing position, invisible,
 * unclosable under the venue's $10 minimum order value, and reported as
 * "closed" because in float space the two numbers were equal.
 */
describe('closePosition — the cap that binds is in wei', () => {
  /** The wei the venue was actually asked for. */
  const placedWei = (api: ReturnType<typeof fakeApi>): bigint => {
    const order = api.calls.find((c) => c.path.startsWith('/v1/calldata-builder/agent/place-order'));
    return BigInt(String(order!.body.size));
  };
  const close = async (api: ReturnType<typeof fakeApi>, over: { size: number; openSizeWei: string }) =>
    client(api).closePosition({
      marketId: HL,
      direction: 'short',
      limitApr: 0.0875,
      clientOrderId: 'c-0000001',
      ...over,
    });

  it('never asks for more than the venue holds, where the float rounds UP', () => {
    // 0.05 is the case that bit a real user: a clean open, and the size that
    // cannot survive the round trip.
    const api = fakeApi();
    return close(api, { size: 50000000000000000 / 1e18, openSizeWei: '50000000000000000' }).then(() => {
      expect(placedWei(api)).toBe(50000000000000000n);
    });
  });

  it('holds the line on a size whose float lands 556 units high', async () => {
    const api = fakeApi();
    await close(api, { size: 123456789000000000000 / 1e18, openSizeWei: '123456789000000000000' });
    expect(placedWei(api)).toBe(123456789000000000000n);
  });

  it('ignores the sign — a short is closed by its magnitude', async () => {
    const api = fakeApi();
    await close(api, { size: 50000000000000000 / 1e18, openSizeWei: '-50000000000000000' });
    expect(placedWei(api)).toBe(50000000000000000n);
  });

  it('still honours a deliberate PARTIAL rather than widening it to the whole', async () => {
    // The cap is a ceiling, not the size. Closing 0.02 of 0.05 must place
    // 0.02 — a cap that overrode the request would close someone's position
    // for them.
    const api = fakeApi();
    await close(api, { size: 0.02, openSizeWei: '50000000000000000' });
    expect(placedWei(api)).toBe(20000000000000000n);
  });

  it('falls back to the float when the venue\'s own field is not an integer', async () => {
    // A cap that cannot be read is no cap. That is the OLD behaviour, which is
    // a shape change on the venue's side rather than a routine case — better
    // than throwing on the close path.
    const api = fakeApi();
    await close(api, { size: 50000000000000000 / 1e18, openSizeWei: '5e16' });
    expect(placedWei(api)).toBe(50000000000000003n);
  });
});

describe('absWei', () => {
  it('reads the venue\'s own integer as a magnitude', () => {
    expect(absWei('50000000000000000')).toBe(50000000000000000n);
    expect(absWei('-50000000000000000')).toBe(50000000000000000n);
    expect(absWei(' 0 ')).toBe(0n);
  });

  it('refuses anything that is not a plain integer, rather than inventing a ceiling', () => {
    // A wrong ceiling silently truncates a close; no ceiling merely restores
    // the previous behaviour.
    expect(absWei('5e16')).toBeNull();
    expect(absWei('0.05')).toBeNull();
    expect(absWei('')).toBeNull();
    expect(absWei('nope')).toBeNull();
  });
});

describe('makeBorosApiOrderClient — the gas top-up', () => {
  it('signs the builder\'s calldata and submits it, billed on the USD zone', async () => {
    const api = fakeApi({ enteredReads: [[HL]] });
    await client(api).payTreasury!(5);

    // The market only picks the treasury and the cross account that pays, so
    // it has to be one on the zone the dollar amount is denominated in.
    const read = api.calls.find((c) => c.path.startsWith('/v1/accounts/entered-markets'))!;
    expect(read.path).toContain(packMarketAcc(ROOT, 0, 3, CROSS_MARKET_ID));

    const build = api.calls.find((c) => c.path === '/v1/calldata-builder/agent/pay-treasury')!;
    expect(build.body).toMatchObject({ accountId: 0, isCross: true, marketId: HL });
    // 18 decimals: what the backend decodes, not what its own DTO documents.
    expect(build.body.amount).toBe('5000000000000000000');

    const datas = api.calls.find((c) => c.path === '/v1/send-txs/bulk-calls')!.body.datas as Array<{
      calldata: string;
      signature: string;
    }>;
    expect(datas).toHaveLength(1);
    expect(datas[0].calldata).toBe('0x7a');
    expect(datas[0].signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it('raises on a refusal, which the venue delivers by RESOLVING', async () => {
    const api = fakeApi({ enteredReads: [[HL]], payReturns: [{ error: 'MMInsufficientCash()' }] });
    await expect(client(api).payTreasury!(5)).rejects.toThrow(/refused the gas top-up/i);
  });

  it('raises when the submission says nothing at all', async () => {
    // `submitCalls` renders any non-array body as `[]`. Reported as done, the
    // user waits on a balance that may never move.
    for (const body of [{}, null, []]) {
      const api = fakeApi({ enteredReads: [[HL]], payReturns: body });
      await expect(client(api).payTreasury!(5)).rejects.toThrow(/cannot tell whether it landed/i);
    }
  });

  it('refuses when the account has entered no USD-collateral market', async () => {
    // The amount is a dollar figure and only that zone makes it one: the same
    // number billed to a BTC-margined market would spend that many bitcoin.
    const api = fakeApi({ enteredReads: [[]] });
    await expect(client(api).payTreasury!(5)).rejects.toThrow(/no USD-collateral market/i);
  });
});
