import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import type { AccountLike } from '../../src/core/rebalance/plan';
import type { RealizePerp } from '../../src/core/rebalance/realize';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { gapsLeftBy, JobFile, newJob, TransferFile, type Job, type JobPerp, type OpenGap } from '../../src/server/rebalanceJob';
import { LOOKUP_WINDOW_MS } from '../../src/server/rebalanceRunner';
import { FEE_ROWS, GATE_ETH, OWNER_HL_ETH, perp, PERP_RULES, realizeBook, type RealizeBook } from '../unit/fixtures/realize-books';
import { gate, HOST, makeTestApp, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';
import { asset, waitFor } from './helpers/rebalance';

const API = '/api/v4';
const HL_ETH = 'HYPERLIQUID_FUTURE_ETH_USDC';
const GATE_ETH_PERP = 'GATE_FUTURE_ETH_USDT';
const LIGHTER_ETH = 'LIGHTER_FUTURE_ETH_USDC';
const OWNER_MARK = 1_821;
const REFUSAL = { label: 'INVALID_PARAM_VALUE', message: 'refused by the test' };

let t: number;
let apps: FastifyInstance[];

beforeEach(() => {
  t = Date.now();
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
  nock.cleanAll();
});

const sleep = async (ms: number): Promise<void> => {
  t += ms;
};

const PERP_RULE_ROWS = Object.entries(PERP_RULES).map(([symbol, rule]) => ({
  symbol,
  exchange_type: symbol.split('_')[0],
  business_type: 'FUTURE',
  state: 'live',
  lot_size: rule.lotSize,
  min_size: rule.minSize,
  min_notional: rule.minNotional,
}));

const FEE_WIRE_ROWS = FEE_ROWS.map((row) => ({
  exchange_type: row.exchangeType,
  future_maker_fee: row.futureMakerFee,
  future_taker_fee: row.futureTakerFee,
  ...(row.exchangeType === 'GATE' ? { spot_maker_fee: '0', spot_taker_fee: '0' } : {}),
  special_fee_list: [],
}));

const wireAccount = (account: AccountLike) => ({
  user_id: '1',
  available_margin: account.availableMargin,
  margin_balance: account.marginBalance,
  initial_margin: account.initialMargin,
  account_mode: 'CROSS_EXCHANGE',
  assets: (account.assets ?? []).map((a) =>
    asset(a.coin ?? '', a.exchangeType ?? '', {
      balance: a.balance ?? '0',
      available_balance: a.availableBalance ?? '0',
      upnl: a.upnl ?? '0',
      equity: a.equity ?? '0',
      liability: a.liability ?? '0',
      borrowing_initial_margin: a.borrowingInitialMargin,
      borrowing_maintenance_margin: a.borrowingMaintenanceMargin,
    }),
  ),
});

const wirePosition = (row: RealizePerp) => ({
  symbol: row.symbol,
  position_side: 'NONE',
  position_qty: row.positionQty,
  position_value: String(Math.abs(Number(row.positionQty)) * Number(row.markPrice)),
  entry_price: row.entryPrice,
  mark_price: row.markPrice,
  initial_margin: row.initialMargin,
  upnl: String(Number(row.positionQty) * (Number(row.markPrice) - Number(row.entryPrice))),
});

const OWNER_RATES = [
  { coin: 'USDT', exchange_type: 'CROSSEX', hour_interest_rate: String(0.0596 / 8760), time: String(Date.now()) },
  { coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: String(0.05 / 8760), time: String(Date.now()) },
];

const ownerAccount = (): RealizeBook =>
  realizeBook({
    usdt: { cash: -7_169.33, upnl: 0 },
    usdc: { cash: 55.98, upnl: 66 * (2_100 - OWNER_MARK) },
    availableMargin: 2_000,
    perps: [perp(HL_ETH, -66, 2_100, OWNER_MARK), perp(GATE_ETH_PERP, 66, OWNER_MARK, OWNER_MARK)],
    books: { [HL_ETH]: OWNER_HL_ETH, GATE_FUTURE_ETH_USDT: GATE_ETH },
    notionalUsd: 66 * OWNER_MARK,
  });

function mockAccount(book: RealizeBook): void {
  gate().persist().get(`${API}/crossex/accounts`).query(true).reply(200, wireAccount(book.account));
  gate().persist().get(`${API}/crossex/interest_rate`).query(true).reply(200, OWNER_RATES);
  gate().persist().get(`${API}/crossex/history_margin_interests`).query(true).reply(200, []);
  gate().persist().get(`${API}/crossex/positions`).query(true).reply(200, book.spec.perps.map(wirePosition));
  gate()
    .persist()
    .get(`${API}/crossex/rule/symbols`)
    .query(true)
    .reply(200, [{ symbol: 'GATE_SPOT_USDC_USDT', exchange_type: 'GATE', business_type: 'SPOT', state: 'live' }, ...PERP_RULE_ROWS]);
  gate().persist().get(`${API}/crossex/fee`).query(true).reply(200, FEE_WIRE_ROWS);
  const levels = (side: Array<[number, number]>) => side.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 }));
  nock('https://api.hyperliquid.xyz')
    .persist()
    .post('/info', (body) => body.type === 'l2Book' && body.coin === 'ETH')
    .reply(200, { coin: 'ETH', levels: [levels(OWNER_HL_ETH.bids), levels(OWNER_HL_ETH.asks)] });
}

function mockGateEthBook(): void {
  nock('https://api.gateio.ws')
    .persist()
    .get('/api/v4/futures/usdt/contracts/ETH_USDT')
    .query(true)
    .reply(200, { name: 'ETH_USDT', quanto_multiplier: '0.01', order_price_round: '0.01' });
  nock('https://api.gateio.ws')
    .persist()
    .get('/api/v4/futures/usdt/order_book')
    .query(true)
    .reply(200, { bids: [{ p: '1820.9', s: 1_000_000 }], asks: [{ p: '1821.1', s: 1_000_000 }] });
}

function refuseSends(): void {
  gate().persist().post(`${API}/crossex/transfers`).query(true).reply(400, REFUSAL);
  gate().persist().post(`${API}/crossex/orders`).query(true).reply(400, REFUSAL);
}

function boot() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rebalance-abandon-'));
  const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const jobs = new JobFile(dataDir);
  const app = makeTestApp({
    getClients,
    rebalance: { jobs, sleep },
    transfer: { jobs: new TransferFile(dataDir) },
    engine: { store: new Store(':memory:'), venue: gateVenue(getClients), clock: { now: () => t } },
  });
  apps.push(app);
  return {
    jobs,
    ready: () => app.ready(),
    file: () => JSON.parse(readFileSync(path.join(dataDir, 'rebalance.json'), 'utf8')) as Job,
    post: (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, headers: HOST, payload }),
  };
}

const DELEVER_JOB = {
  makerLeg: 0 as const,
  legs: [
    { symbol: HL_ETH, exchange: 'HYPERLIQUID', base: 'ETH', side: 'SHORT' as const, before: 66, after: 33, closeQty: 33 },
    { symbol: GATE_ETH_PERP, exchange: 'GATE', base: 'ETH', side: 'LONG' as const, before: 66, after: 33, closeQty: 33 },
  ],
  boros: [],
};

const slicedJob = (over: Partial<Job>): Job => ({
  ...newJob({ route: 'mix', steps: [], amount: 0, costUsd: 30, target: [], userId: '1', kind: 'delever', delever: DELEVER_JOB, sliceCount: 14, sliceUsd: 25_000 }, t),
  ...over,
});

const tagOnlyOrder = (sentAt: number) => ({ text: `t-ab-${sentAt}`, venueId: null, sentAt, credited: 0, poc: false, price: null, side: 'SELL' as const, mid: null });

const livePair = (hl: number, gateQty: number, extra: JobPerp[] = []): JobPerp[] => [
  { symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'SHORT', qty: hl },
  { symbol: GATE_ETH_PERP, exchange: 'GATE', side: 'LONG', qty: gateQty },
  ...extra,
];

const lighterShort = (qty: number): JobPerp => ({ symbol: LIGHTER_ETH, exchange: 'LIGHTER', side: 'SHORT', qty });

const gateGap = (q: number): OpenGap => ({
  leg: { symbol: GATE_ETH_PERP, base: 'ETH', exchange: 'GATE', side: 'LONG', positionQty: 66, hedge: 'HYPERLIQUID' },
  qty: q,
  hedges: [{ symbol: HL_ETH, exchange: 'HYPERLIQUID', side: 'SHORT', qty: 66 }],
});

describe('Abandon with an add back order Gate never confirmed', () => {
  it.each([
    [0.0166, '0.0166'],
    [2_000, '2,000'],
  ])('a tag-only add back order the read cannot find past the window is named, and stores a worst-case gap, %d ETH', async (q, size) => {
    mockAccount(ownerAccount());
    gate().get(/\/api\/v4\/crossex\/orders\/.+/).query(true).reply(404, { label: 'ORDER_NOT_FOUND', message: 'not found' });
    const h = boot();
    await h.ready();
    const job = slicedJob({ status: 'halted', haltKind: 'boros', borosLeftYu: 30, haltReason: 'Add back stopped.' });
    job.steps[job.stepIndex].addBack = { qty: q, legs: [{ symbol: HL_ETH, filled: 0, order: tagOnlyOrder(t - LOOKUP_WINDOW_MS - 1) }, { symbol: GATE_ETH_PERP, filled: 0, order: null }] };
    h.jobs.write(job);

    const abandon = await h.post(`/api/rebalance/${job.id}/abandon`);

    expect(abandon.statusCode).toBe(200);
    const file = h.file();
    expect(file.status).toBe('abandoned');
    expect(file.haltReason).toBe(
      `Add back stopped: Hyperliquid 0 of ${size} ETH, Gate 0 of ${size} ETH. Gate has not confirmed the Hyperliquid add back order. Check the Hyperliquid short in Positions before you trade.`,
    );
    expect(file.steps[file.stepIndex].addBack?.legs[0].order).toBeNull();
    expect(file.openGaps).toEqual([gateGap(q)]);
  });

  it.each([0.0166, 2_000])('an unread add back leg keeps a card gap while the live perps are uneven, and none when they are even, %d ETH', async (q) => {
    mockAccount(ownerAccount());
    gate().get(/\/api\/v4\/crossex\/orders\/.+/).query(true).reply(404, { label: 'ORDER_NOT_FOUND', message: 'not found' });
    const h = boot();
    await h.ready();
    const job = slicedJob({ status: 'halted', haltKind: 'boros', borosLeftYu: 30, haltReason: 'Add back stopped.' });
    job.steps[job.stepIndex].addBack = { qty: q, legs: [{ symbol: HL_ETH, filled: 0, order: tagOnlyOrder(t - LOOKUP_WINDOW_MS - 1) }, { symbol: GATE_ETH_PERP, filled: 0, order: null }] };
    h.jobs.write(job);
    await h.post(`/api/rebalance/${job.id}/abandon`);
    h.jobs.write({ ...h.file(), borosLeftYu: 0, borosGapYu: 0 });

    const closed = h.file();
    expect(gapsLeftBy(closed, livePair(33 + q, 33))).toEqual([gateGap(q)]);
    expect(gapsLeftBy(closed, livePair(33, 33))).toEqual([]);
  });

  it.each([0.0166, 2_000])('both add back orders unread: the card names whichever perp the live sizes show is smaller, %d ETH', async (q) => {
    mockAccount(ownerAccount());
    gate().persist().get(/\/api\/v4\/crossex\/orders\/.+/).query(true).reply(404, { label: 'ORDER_NOT_FOUND', message: 'not found' });
    const h = boot();
    await h.ready();
    const job = slicedJob({ status: 'halted', haltKind: 'boros', borosLeftYu: 30, haltReason: 'Add back stopped.' });
    const old = t - LOOKUP_WINDOW_MS - 1;
    job.steps[job.stepIndex].addBack = { qty: q, legs: [{ symbol: HL_ETH, filled: 0, order: tagOnlyOrder(old) }, { symbol: GATE_ETH_PERP, filled: 0, order: { ...tagOnlyOrder(old + 1), side: 'BUY' as const } }] };
    h.jobs.write(job);
    await h.post(`/api/rebalance/${job.id}/abandon`);

    const closed = h.file();
    expect(gapsLeftBy(closed, livePair(33 + q, 33))).toEqual([gateGap(q)]);
    expect(gapsLeftBy(closed, livePair(33, 33 + q))).toEqual([expect.objectContaining({ qty: q, leg: expect.objectContaining({ symbol: HL_ETH, side: 'SHORT' }) })]);
    expect(gapsLeftBy(closed, livePair(33 + q, 33 + q))).toEqual([]);
  });
});

describe('the stored add back gap reads only its own hedge', () => {
  it.each([0.0166, 2_000])('the pair evened plus a Lighter short of 500 gives no gap; the pair uneven still gives the gap, %d ETH', async (q) => {
    mockAccount(ownerAccount());
    const h = boot();
    await h.ready();
    const job = slicedJob({ status: 'halted', haltKind: 'boros', borosLeftYu: 30, haltReason: 'Add back stopped.' });
    job.steps[job.stepIndex].addBack = { qty: q, legs: [{ symbol: HL_ETH, filled: q, order: null }, { symbol: GATE_ETH_PERP, filled: 0, order: null }] };
    h.jobs.write(job);
    await h.post(`/api/rebalance/${job.id}/abandon`);

    const closed = h.file();
    expect(gapsLeftBy(closed, livePair(33 + q, 33 + q, [lighterShort(500)]))).toEqual([]);
    expect(gapsLeftBy(closed, livePair(33 + q, 33, [lighterShort(500)]))).toEqual([gateGap(q)]);
  });
});

describe('a new Delever keeps the gaps the last job left', () => {
  it.each([0.0166, 2_000])('a stored add back gap survives a new Delever start, %d ETH', async (q) => {
    mockAccount(ownerAccount());
    mockGateEthBook();
    refuseSends();
    const h = boot();
    await h.ready();
    const stored: OpenGap = { ...gateGap(q), leg: { ...gateGap(q).leg, positionQty: 66 + q } };
    h.jobs.write(slicedJob({ status: 'abandoned', openGaps: [stored] }));
    const ask = { perps: [{ symbol: HL_ETH, qty: 10 }, { symbol: GATE_ETH_PERP, qty: 10 }], boros: [], exec: 'maker' };
    const plan = (await h.post('/api/rebalance/delever/plan', ask)).json().data;

    const res = await h.post('/api/rebalance', { kind: 'delever', exec: 'maker', costUsd: plan.estimates.maker.totalUsd, delever: ask });

    expect(res.statusCode).toBe(202);
    expect(h.file().openGaps).toEqual([stored]);
    expect(h.file().before?.perps).toEqual(livePair(66, 66));
    await waitFor(() => h.file().status === 'halted', 'the halt');
  });
});
