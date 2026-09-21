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
const USD_MARKET = 900;

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
    /** A non-2xx HTTP response the ORDER submission answers with, so `call`
     * throws a CoreError carrying the status — the 4xx-vs-5xx split. */
    submitHttp?: { status: number; body?: unknown };
    /** Body the place-order calldata builder answers with, to drive the
     * "returned no calldata" refusal before anything reaches the chain. */
    orderBuildReturns?: unknown;
    /** A non-2xx answer from the roll-over builder. */
    rollBuildHttp?: { status: number; body?: unknown };
    /** Body the roll-over preview answers with. */
    rollSimReturns?: unknown;
    failEnter?: string;
    /** Raw body the ENTER submission answers with, for the shapes that are
     * neither a clean success nor a per-call error. */
    enterReturns?: unknown;
    payReturns?: unknown;
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
      if (over.orderBuildReturns !== undefined) return ok(over.orderBuildReturns);
      return ok({ calls: [{ calldata: `0xda${calls.length.toString(16).padStart(2, '0')}` }] });
    }
    if (path.startsWith('/v1/calldata-builder/agent/roll-over')) {
      if (over.rollBuildHttp) {
        return { ok: false, status: over.rollBuildHttp.status, json: async () => over.rollBuildHttp!.body ?? {} };
      }
      // Closes then opens, each naming its market, side (0 long / 1 short) and size.
      const legs = body.legs as Array<{ fromMarketId: number; toMarketId: number; size: string; closeRate?: number; openRate?: number }>;
      const closeSide = (i: number) => (i === 0 ? 0 : 1); // HL was SHORT (closes long), BN was LONG (closes short)
      return ok({
        calls: [
          ...legs.map((l, i) => ({ calldata: `0xc${i + 1}`, accountId: 0, action: 'close', marketId: l.fromMarketId, size: l.size, resolved: { side: closeSide(i), requestedRate: l.closeRate } })),
          ...legs.map((l, i) => ({ calldata: `0xo${i + 1}`, accountId: 0, action: 'open', marketId: l.toMarketId, size: l.size, resolved: { side: 1 - closeSide(i), requestedRate: l.openRate } })),
        ],
      });
    }
    if (path.startsWith('/v1/simulations/roll-over')) {
      if (over.rollSimReturns !== undefined) return ok(over.rollSimReturns);
      const legs = body.legs as Array<{ fromMarketId: number; toMarketId: number; size: string }>;
      const wei = (n: number) => (BigInt(n) * 10n ** 18n).toString();
      return ok({
        status: 'Succeed',
        reason: null,
        preState: { availableInitialMargin: wei(5_000) },
        exitState: { availableInitialMargin: wei(5_300) },
        postState: { availableInitialMargin: wei(4_100) },
        marginRequired: wei(700),
        orders: [
          ...legs.map((l) => ({ action: 'close', marketId: l.fromMarketId, filled: true, matched: { size: `-${l.size}`, cost: '0', rate: 0.091 }, fee: wei(4), error: null })),
          ...legs.map((l) => ({ action: 'open', marketId: l.toMarketId, filled: true, matched: { size: l.size, cost: '0', rate: 0.099 }, fee: wei(4), error: null })),
        ],
      });
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
      if (datas.length === 1 && datas[0]?.calldata === '0x7a') {
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
      // A non-2xx answer to the ORDER submission — `call` turns it into a
      // CoreError carrying the status, which is the 4xx-vs-5xx branch point.
      if (over.submitHttp) {
        return { ok: false, status: over.submitHttp.status, json: async () => over.submitHttp!.body ?? {} };
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

const client = (api: ReturnType<typeof fakeApi>, over: { noUsdMarket?: boolean } = {}) =>
  makeBorosApiOrderClient({
    root: ROOT,
    accountId: 0,
    agentPrivateKey: AGENT_KEY,
    // Both legs on ETH collateral: an eligible pair must share a token, which
    // is also what makes them one cross account.
    tokenIdForMarket: () => 2,
    usdMarketId: over.noUsdMarket ? undefined : () => USD_MARKET,
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

/**
 * Gas the order pays for itself.
 *
 * Boros funds its relayer from an off-chain USD budget, and an account with
 * plenty of margin can still be unable to send an order. A low balance used to
 * be a confirm blocker, which was a dead end. The relayer's own pre-check
 * counts a `payTreasury` in the SAME submission as a credit, so an order that
 * carries its own top-up is accepted at zero — which is what the venue's own
 * app does.
 */
describe('makeBorosApiOrderClient — an order tops up its own gas', () => {
  const orderSubmit = (api: ReturnType<typeof fakeApi>) =>
    api.calls
      .filter((c) => c.path === '/v1/send-txs/bulk-calls')
      .map((c) => c.body.datas as Array<{ calldata: string }>)
      .pop()!;

  it('prepends a pay-treasury when the budget is low, and charges the USD market', async () => {
    const api = fakeApi({ gasBalance: { balanceInUSD: 0.05 } });
    await client(api).placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]);

    expect(orderSubmit(api).map((d) => d.calldata)[0]).toBe('0x7a');
    expect(orderSubmit(api)).toHaveLength(3); // top-up + two legs, ONE submission

    const pay = api.calls.find((c) => c.path.includes('agent/pay-treasury'))!;
    // The top-up comes out of USD collateral, so it must not be charged
    // through one of the ETH markets being traded.
    expect(pay.body.marketId).toBe(USD_MARKET);
    expect(pay.body.amount).toBe('1000000000000000000'); // $1, 18dp
  });

  it('clears the debt as well when the budget is already negative', async () => {
    const api = fakeApi({ gasBalance: { balanceInUSD: -0.8 } });
    await client(api).placeMarketOrders([leg()]);

    const pay = api.calls.find((c) => c.path.includes('agent/pay-treasury'))!;
    // $1 on top of the $0.80 owed — the venue charges its own users the same.
    expect(pay.body.amount).toBe('1800000000000000000');
  });

  it('leaves a healthy budget alone', async () => {
    const api = fakeApi({ gasBalance: { balanceInUSD: 42 } });
    await client(api).placeMarketOrders([leg()]);

    expect(api.calls.some((c) => c.path.includes('agent/pay-treasury'))).toBe(false);
    expect(orderSubmit(api)).toHaveLength(1);
  });

  /** An EXIT is funded only when it truly cannot pay. The relayer's floor is 0
   * and an order costs cents, so anything above zero already covers a close;
   * charging it a dollar of margin there buys nothing. */
  it('does not tax a close that the budget can already afford', async () => {
    const api = fakeApi({ gasBalance: { balanceInUSD: 0.05 } });
    await client(api).placeMarketOrders([leg()], { reducing: true });

    expect(api.calls.some((c) => c.path.includes('agent/pay-treasury'))).toBe(false);
    expect(orderSubmit(api)).toHaveLength(1);
  });

  it('still funds a close the budget genuinely cannot pay for', async () => {
    const api = fakeApi({ gasBalance: { balanceInUSD: -0.4 } });
    await client(api).placeMarketOrders([leg()], { reducing: true });

    const pay = api.calls.find((c) => c.path.includes('agent/pay-treasury'))!;
    expect(pay.body.amount).toBe('1400000000000000000'); // $1 on top of $0.40 owed
  });

  /** The top-up occupies slot 0, so a leg reading results positionally would
   * take the top-up's outcome as its own fill and report nothing traded. */
  it('still attributes each leg its own fill once the bundle is shifted', async () => {
    const api = fakeApi({
      gasBalance: { balanceInUSD: 0 },
      status: {
        status: 'success',
        statuses: [
          { index: 0 },                                        // the top-up
          { index: 1, marketOrdersExecuted: [filled(HL, '10000000000000000000')] },
          { index: 2, marketOrdersExecuted: [filled(BN, '10000000000000000000')] },
        ],
      },
    });
    const fills = await client(api).placeMarketOrders([
      leg(),
      leg({ marketId: BN, direction: 'long' }),
    ]);

    expect(fills.map((f) => f.marketId)).toEqual([HL, BN]);
    expect(fills.map((f) => f.filledSize)).toEqual([10, 10]);
    expect(fills.some((f) => f.failure)).toBe(false);
  });

  it('fails every leg when the top-up itself reverts — one submission, one fate', async () => {
    const api = fakeApi({
      gasBalance: { balanceInUSD: 0 },
      submit: () => [{ error: 'INSUFFICIENT_MARGIN' }],
    });
    const fills = await client(api).placeMarketOrders([leg()]);
    expect(fills[0].failure?.code).toBe('insufficient-margin');
  });

  /** Best effort by design: a supplementary read must never be the reason a
   * trade does not go out. If the budget really was too low the venue refuses
   * the bundle, and that is reported as a gas failure. */
  it('sends the order anyway when it cannot work out a top-up', async () => {
    const api = fakeApi({ gasBalance: { balanceInUSD: 0 } });
    await client(api, { noUsdMarket: true }).placeMarketOrders([leg()]);

    expect(api.calls.some((c) => c.path.includes('agent/pay-treasury'))).toBe(false);
    expect(orderSubmit(api)).toHaveLength(1);
  });

  it('sends the order anyway when the gas balance cannot be read', async () => {
    const api = fakeApi({ gasBalance: {} });
    await client(api).placeMarketOrders([leg()]);

    expect(api.calls.some((c) => c.path.includes('agent/pay-treasury'))).toBe(false);
    expect(orderSubmit(api)).toHaveLength(1);
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

describe('makeBorosApiOrderClient — rollOver', () => {
  const legs = [
    { fromMarketId: HL, toMarketId: HL + 1, size: 100, closeRate: 0.0925, openRate: 0.0975 },
    { fromMarketId: BN, toMarketId: BN + 1, size: 100, closeRate: 0.0425, openRate: 0.0525 },
  ];

  it('asks the venue for the whole roll once, on the cross account, orderbook-only, sizes in wei', async () => {
    const api = fakeApi();
    await client(api).rollOver!(legs);
    const build = api.calls.filter((c) => c.path === '/v1/calldata-builder/agent/roll-over');
    expect(build).toHaveLength(1);
    expect(build[0].body).toMatchObject({
      marketAcc: packMarketAcc(ROOT, 0, 2, CROSS_MARKET_ID),
      legs: [
        { fromMarketId: HL, toMarketId: HL + 1, size: (100n * 10n ** 18n).toString(), closeRate: 0.0925, openRate: 0.0975, ammId: 0 },
        { fromMarketId: BN, toMarketId: BN + 1, size: (100n * 10n ** 18n).toString(), closeRate: 0.0425, openRate: 0.0525, ammId: 0 },
      ],
    });
    // No per-leg place-order builds: the venue built all four.
    expect(api.calls.some((c) => c.path === '/v1/calldata-builder/agent/place-order')).toBe(false);
  });

  it("submits the venue's calls as ONE batch, closes then opens, top-up between them, and reads a fill per call", async () => {
    const api = fakeApi({
      gasBalance: { balanceInUSD: 0.1 },
      status: {
        status: 'success',
        statuses: [0, 1, 2, 3, 4].map((index) => ({
          index,
          status: 'success',
          marketOrdersExecuted: index === 2 ? [] : [{ marketId: [HL, BN, 0, HL + 1, BN + 1][index], size: (100n * 10n ** 18n).toString() }],
        })),
      },
    });
    const fills = await client(api).rollOver!(legs);
    const submit = api.calls.find((c) => c.path === '/v1/send-txs/bulk-calls' && (c.body.datas as unknown[]).length === 5)!;
    expect(submit.body.requireSuccess).toBe(true);
    // [closeHL, closeBN, payTreasury, openHL', openBN'] — the top-up after the closes.
    expect((submit.body.datas as Array<{ calldata: string }>).map((d) => d.calldata)).toEqual(['0xc1', '0xc2', '0x7a', '0xo1', '0xo2']);
    expect(fills.map((f) => [f.marketId, f.direction, f.filledSize, f.failure])).toEqual([
      [HL, 'long', 100, null],
      [BN, 'short', 100, null],
      [HL + 1, 'short', 100, null],
      [BN + 1, 'long', 100, null],
    ]);
  });

  it("reads the venue's preview into collateral units, sizes unsigned", async () => {
    const api = fakeApi();
    const sim = await client(api).simulateRollOver!(legs);
    expect((api.calls.find((c) => c.path === '/v1/simulations/roll-over')!.body.legs as Array<{ fromMarketId: number }>).map((l) => l.fromMarketId)).toEqual([HL, BN]);
    expect(sim.status).toBe('Succeed');
    expect(sim.availableBefore).toBe(5_000);
    expect(sim.availableAfter).toBe(4_100);
    expect(sim.availableAfterExit).toBe(5_300);
    expect(sim.marginRequired).toBe(700);
    expect(sim.orders.map((o) => [o.action, o.marketId, o.filled, o.matchedSize, o.matchedApr, o.fee, o.error])).toEqual([
      ['close', HL, true, 100, 0.091, 4, null],
      ['close', BN, true, 100, 0.091, 4, null],
      ['open', HL + 1, true, 100, 0.099, 4, null],
      ['open', BN + 1, true, 100, 0.099, 4, null],
    ]);
    // A refusal keeps its reason and the per-order errors; no post state.
    const refusedApi = fakeApi({
      rollSimReturns: {
        status: 'Refused',
        reason: { errorCode: 'MARKET_ORDER_FOK_NOT_FILLED', message: 'Insufficient liquidity' },
        preState: { availableInitialMargin: '0' },
        postState: null,
        marginRequired: '0',
        orders: [{ action: 'open', marketId: HL + 1, filled: false, matched: null, fee: null, error: 'Insufficient liquidity' }],
      },
    });
    const refused = await client(refusedApi).simulateRollOver!(legs);
    // A venue that reports no exit state (older, or the closes could not run) reads as unknown, not 0.
    expect(refused).toMatchObject({ status: 'Refused', reason: { code: 'MARKET_ORDER_FOK_NOT_FILLED' }, availableAfter: null, availableAfterExit: null });
    expect(refused.orders[0]).toEqual({ action: 'open', marketId: HL + 1, filled: false, matchedSize: null, matchedApr: null, fee: null, error: 'Insufficient liquidity' });
  });

  it('reports a builder refusal as four rejected legs — nothing was sent', async () => {
    const api = fakeApi({ rollBuildHttp: { status: 404, body: { message: 'Market position not found' } } });
    const fills = await client(api).rollOver!(legs);
    expect(fills).toHaveLength(4);
    expect(fills.map((f) => f.marketId)).toEqual([HL, BN, HL + 1, BN + 1]);
    expect(fills.every((f) => f.failure?.code === 'rejected' && /Market position not found/.test(f.failure.message))).toBe(true);
    expect(api.calls.some((c) => c.path === '/v1/send-txs/bulk-calls')).toBe(false);
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

  it('names the leg whose call reverted on-chain', async () => {
    const api = fakeApi({
      status: {
        statuses: [
          { index: 0, marketOrdersExecuted: [filled(HL, '10000000000000000000')] },
          { index: 1, error: 'MarketOrderFOKNotFilled' },
        ],
      },
    });
    const [a, b] = await client(api).placeMarketOrders([leg({ size: 10 }), leg({ marketId: BN, direction: 'long', size: 10 })]);
    expect(a.failure).toBeNull();
    expect(b.failure).toMatchObject({ code: 'insufficient-depth', cause: 'this-leg' });
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
  /**
   * Entering is NOT done here. The place-order builder reads the account's
   * entered markets and sets `enterMarket` on the order itself
   * (calldata.service + BatchMarketEntryTracker), so a separate enter-markets
   * submission was a second transaction doing work the order already did —
   * and it went out with no gas top-up of its own. Verified live: an order on
   * a never-entered market filled and entered it, with this step removed.
   */
  it('does not send a separate enter-markets submission', async () => {
    const api = fakeApi();
    await client(api).placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]);
    expect(api.calls.filter((c) => c.path.includes('enter-markets'))).toHaveLength(0);
    expect(api.calls.filter((c) => c.path.startsWith('/v1/accounts/entered-markets'))).toHaveLength(0);
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
    expect(await client(fakeApi({ gasBalance: {} })).getGasBalance?.()).toBeNull();
    expect(await client(fakeApi({ gasBalance: null })).getGasBalance?.()).toBeNull();
  });
});

describe('makeBorosApiOrderClient — a result that says nothing is not a result', () => {
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
  it('signs the builder\'s calldata and submits it, billed on the market it is given', async () => {
    const api = fakeApi({});
    await client(api).payTreasury!(5, HL);

    expect(api.calls.some((c) => c.path.startsWith('/v1/accounts/entered-markets'))).toBe(false);

    const build = api.calls.find((c) => c.path === '/v1/calldata-builder/agent/pay-treasury')!;
    expect(build.body).toMatchObject({ accountId: 0, isCross: true, marketId: HL });
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
    const api = fakeApi({ payReturns: [{ error: 'MMInsufficientCash()' }] });
    await expect(client(api).payTreasury!(5, HL)).rejects.toThrow(/refused the gas top-up/i);
  });

  it('raises when the submission says nothing at all', async () => {
    for (const body of [{}, null, []]) {
      const api = fakeApi({ payReturns: body });
      await expect(client(api).payTreasury!(5, HL)).rejects.toThrow(/cannot tell whether it landed/i);
    }
  });

});

/**
 * `topUpAfter` decides where the auto gas top-up sits in the submission. The
 * relayer sums the whole batch and checks it once, so the credit counts
 * wherever it sits — what the position decides is when `payTreasury`'s own
 * strict margin check runs. A roll places it after the closes (index 2).
 */
describe('makeBorosApiOrderClient — topUpAfter positions the gas top-up', () => {
  const orderSubmit = (api: ReturnType<typeof fakeApi>) =>
    api.calls
      .filter((c) => c.path === '/v1/send-txs/bulk-calls')
      .map((c) => c.body.datas as Array<{ calldata: string }>)
      .pop()!;
  const M3 = 200;
  const M4 = 201;

  it('inserts the top-up at submission index 2 on a four-leg batch, and reads each leg from its own status index', async () => {
    const api = fakeApi({
      gasBalance: { balanceInUSD: 0.05 },
      status: {
        status: 'success',
        statuses: [
          { index: 0, marketOrdersExecuted: [filled(HL, '10000000000000000000')] },
          { index: 1, marketOrdersExecuted: [filled(BN, '20000000000000000000')] },
          { index: 2 }, // the top-up — carries no fill
          { index: 3, marketOrdersExecuted: [filled(M3, '30000000000000000000')] },
          { index: 4, marketOrdersExecuted: [filled(M4, '40000000000000000000')] },
        ],
      },
    });
    const fills = await client(api).placeMarketOrders(
      [
        leg({ marketId: HL, size: 10 }),
        leg({ marketId: BN, direction: 'long', size: 20 }),
        leg({ marketId: M3, size: 30 }),
        leg({ marketId: M4, direction: 'long', size: 40 }),
      ],
      { reducing: false, topUpAfter: 2 },
    );

    const submission = orderSubmit(api);
    expect(submission).toHaveLength(5); // four legs + the shifted top-up
    expect(submission[2].calldata).toBe('0x7a'); // payTreasury at submission index 2
    // Each leg reads ITS OWN status entry across the shifted slot — no leg takes
    // the top-up's outcome, and no leg reads its neighbour's fill.
    expect(fills.map((f) => f.marketId)).toEqual([HL, BN, M3, M4]);
    expect(fills.map((f) => f.filledSize)).toEqual([10, 20, 30, 40]);
    expect(fills.some((f) => f.failure)).toBe(false);
  });

  it('places the reducing top-up LAST when topUpAfter = reqs.length', async () => {
    // The reducing floor is unchanged (a negative budget still funds the close),
    // but the call now sits AFTER the legs it is funded behind.
    const api = fakeApi({ gasBalance: { balanceInUSD: -0.4 } });
    await client(api).placeMarketOrders(
      [leg({ marketId: HL }), leg({ marketId: BN, direction: 'long' })],
      { reducing: true, topUpAfter: 2 },
    );
    const submission = orderSubmit(api);
    expect(submission).toHaveLength(3);
    expect(submission[2].calldata).toBe('0x7a'); // top-up LAST (reqs.length = 2)
    expect(submission.slice(0, 2).every((d) => d.calldata.startsWith('0xda'))).toBe(true);
  });
});

/**
 * Under `requireSuccess` EVERY call in a refused batch carries an error: the one
 * that failed carries the reason, the rest "Batch aborted". The client reports
 * the SPECIFIC reason on every leg and marks which leg the venue actually named.
 */
describe('makeBorosApiOrderClient — requireSuccess failure attribution', () => {
  const ABORT = '[SIMULATE] Batch aborted: requireSuccess=true but some calls failed';
  const REASON = '[SIMULATE] Not enough margin';

  it('reports the specific reason on both legs and names the one the venue refused', async () => {
    // Low gas prepends a top-up, so the submission is [topUp, legA, legB]; the
    // backend refuses legB and aborts the rest.
    const api = fakeApi({
      gasBalance: { balanceInUSD: 0.05 },
      submit: () => [{ error: ABORT }, { error: ABORT }, { error: REASON }],
    });
    const [a, b] = await client(api).placeMarketOrders([
      leg({ marketId: HL }),
      leg({ marketId: BN, direction: 'long' }),
    ]);
    expect(a.failure).toMatchObject({ code: 'insufficient-margin', message: REASON, cause: 'batch' });
    expect(b.failure).toMatchObject({ code: 'insufficient-margin', message: REASON, cause: 'this-leg' });
  });

  it('marks every leg batch when the top-up itself is the failing call', async () => {
    const api = fakeApi({
      gasBalance: { balanceInUSD: 0.05 },
      submit: () => [{ error: REASON }, { error: ABORT }, { error: ABORT }],
    });
    const fills = await client(api).placeMarketOrders([
      leg({ marketId: HL }),
      leg({ marketId: BN, direction: 'long' }),
    ]);
    expect(fills.every((f) => f.failure?.message === REASON)).toBe(true);
    expect(fills.every((f) => f.failure?.code === 'insufficient-margin')).toBe(true);
    expect(fills.every((f) => f.failure?.cause === 'batch')).toBe(true);
  });
});

/**
 * A leg refused BEFORE the chain — calldata could not be built, or the
 * submission was turned away with a 4xx — has a CERTAIN fill state (nothing
 * traded), so its 'unknown' is demoted to 'rejected'. A 5xx/timeout is not
 * certain and still throws.
 */
describe('makeBorosApiOrderClient — a refusal before the chain never reads as unknown', () => {
  it('fails every leg rejected (never unknown) when the calldata builder returns nothing', async () => {
    const api = fakeApi({ orderBuildReturns: { calls: [] } });
    const fills = await client(api).placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]);
    expect(fills).toHaveLength(2);
    expect(fills.every((f) => f.failure?.code === 'rejected')).toBe(true);
  });

  it('fails every leg rejected (never unknown) when the transport rejects while building', async () => {
    // A dropped connection while building/signing ran nothing, so the state is
    // CERTAIN — the network-shaped 'unknown' is demoted to 'rejected'.
    const c = makeBorosApiOrderClient({
      root: ROOT,
      accountId: 0,
      agentPrivateKey: AGENT_KEY,
      tokenIdForMarket: () => 2,
      usdMarketId: () => USD_MARKET,
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
      statusAttempts: 1,
      sleep: async () => {},
    });
    const fills = await c.placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]);
    expect(fills.every((f) => f.failure?.code === 'rejected')).toBe(true);
    expect(fills.some((f) => /ECONNRESET|unreachable/i.test(f.failure!.message))).toBe(true);
  });

  it('fails a 429 from bulk-calls rejected (never unknown), with the HTTP text in the message', async () => {
    const api = fakeApi({ submitHttp: { status: 429, body: { message: 'rate limited, back off' } } });
    const fills = await client(api).placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]);
    expect(fills.every((f) => f.failure?.code === 'rejected')).toBe(true);
    expect(fills.every((f) => /429/.test(f.failure!.message))).toBe(true);
  });

  it('throws on a 503 from bulk-calls — a 5xx leaves the fill state genuinely unknown', async () => {
    const api = fakeApi({ submitHttp: { status: 503, body: { message: 'upstream unavailable' } } });
    await expect(
      client(api).placeMarketOrders([leg(), leg({ marketId: BN, direction: 'long' })]),
    ).rejects.toThrow(/503/);
  });
});
