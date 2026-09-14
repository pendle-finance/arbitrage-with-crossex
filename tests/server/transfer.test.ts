import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClients } from '../../src/core/clients';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import {
  HALT_TEXT,
  JobFile,
  LOCK_TEXT,
  newJob,
  newTransferJob,
  TransferFile,
  type Job,
  type TransferJob,
} from '../../src/server/rebalanceJob';
import { gate, HOST, makeTestApp, mockGateGet, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';
import { waitFor } from './helpers/rebalance';

const API = '/api/v4';
const HL_OUT = { coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: '11.88' };

let apps: FastifyInstance[];

beforeEach(() => {
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
});

const noWait = async (): Promise<void> => undefined;

const asset = (coin: string, venue: string, balance: string) => ({
  coin,
  exchange_type: venue,
  balance,
  equity: balance,
  upnl: '0',
  liability: '0',
  borrowing_initial_margin: '0',
  borrowing_maintenance_margin: '0',
});

const account = {
  user_id: '1',
  available_margin: '831.95',
  margin_balance: '988.23',
  initial_margin: '156.28',
  account_mode: 'CROSS_EXCHANGE',
  assets: [asset('USDT', 'CROSSEX', '986.60'), asset('USDC', 'HYPERLIQUID', '11.92'), asset('USDC', 'GATE', '0.29')],
};

const coins = [
  { coin: 'USDT', min_trans_amount: '0.00000001', est_fee: '0', precision: 8, is_disabled: 0 },
  { coin: 'USDC', min_trans_amount: '11', est_fee: '1', precision: 5, is_disabled: 0 },
];

const SPOT_ROWS = [
  { currency: 'USDT', available: '318.42', locked: '0' },
  { currency: 'USDC', available: '0', locked: '0' },
];

const RATE_LIMITED = { label: 'TOO_MANY_REQUESTS', message: 'slow down' };

function mockReads(
  opts: {
    spot?: { status?: number; body: unknown };
    onAccountRead?: () => void;
    delayMs?: number;
    accountThen429?: boolean;
    spotThen429?: boolean;
  } = {},
) {
  const calls = { account: 0, coins: 0, spot: 0 };
  if (opts.accountThen429) {
    gate()
      .get(`${API}/crossex/accounts`)
      .query(true)
      .reply(200, () => {
        calls.account += 1;
        return account;
      });
    gate()
      .persist()
      .get(`${API}/crossex/accounts`)
      .query(true)
      .reply(429, () => {
        calls.account += 1;
        return RATE_LIMITED;
      });
  } else {
    gate()
      .persist()
      .get(`${API}/crossex/accounts`)
      .query(true)
      .delay(opts.delayMs ?? 0)
      .reply(200, () => {
        calls.account += 1;
        opts.onAccountRead?.();
        return account;
      });
  }
  if (opts.spotThen429) {
    gate()
      .get(`${API}/spot/accounts`)
      .query(true)
      .reply(200, () => {
        calls.spot += 1;
        return SPOT_ROWS;
      });
    gate()
      .persist()
      .get(`${API}/spot/accounts`)
      .query(true)
      .reply(429, () => {
        calls.spot += 1;
        return RATE_LIMITED;
      });
  }
  gate()
    .persist()
    .get(`${API}/crossex/transfers/coin`)
    .query(true)
    .reply(200, () => {
      calls.coins += 1;
      return coins;
    });
  if (!opts.spotThen429) {
    gate()
      .persist()
      .get(`${API}/spot/accounts`)
      .query(true)
      .reply(opts.spot?.status ?? 200, () => {
        calls.spot += 1;
        return opts.spot?.body ?? SPOT_ROWS;
      });
  }
  return calls;
}

function mockSend(reply: { status: number; body: unknown } = { status: 200, body: { tx_id: '123', text: 't' } }) {
  const sent: Record<string, unknown>[] = [];
  gate()
    .persist()
    .post(`${API}/crossex/transfers`)
    .reply(function (_uri, body) {
      sent.push(body as Record<string, unknown>);
      return [reply.status, reply.body];
    });
  return sent;
}

const mockRows = (status: string, over: Record<string, unknown> = {}) =>
  gate()
    .persist()
    .get(`${API}/crossex/transfers`)
    .query(true)
    .reply(200, [{ id: 123, text: 't-tr', coin: 'USDC', amount: '11.88', status, ...over }]);

const rebalanceJob = (status: Job['status']): Job => ({
  ...newJob(
    {
      direction: 'toUsdc',
      route: 'loop',
      steps: [{ round: 1, kind: 'round', buy: 12, move: 12, arrives: 11.95, borrowLeft: 0, seconds: 130 }],
      amount: 12,
      costUsd: 0.05,
      target: [],
      userId: '1',
    },
    Date.now(),
  ),
  status,
});

const movingTransfer = (over: Partial<TransferJob> = {}): TransferJob => ({
  ...newTransferJob({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 11.88, userId: '1' }, Date.now()),
  ...over,
});

function createWorkingDeal(store: Store): void {
  store.createPair({
    id: 'deal-working',
    mode: 'OPENING',
    a: { contract: 'GATE_FUTURE_ETH_USDT', side: 'BUY', lot: '0.001', minSize: '0', minNotional: '0', tick: '0.01' },
    b: null,
    targetQty: '0.05',
    limitPrice: '2500',
    pricePolicy: 'fixed',
    deadlineAt: null,
    makerNotBefore: 0,
    hedgeNotBefore: 0,
    pocRejects: 0,
    hedgeRejectStreak: 0,
    maxClip: null,
    clipBandBp: null,
    haltReason: null,
    reportJson: null,
    createdAt: Date.now(),
  });
}

function boot(over: { sleep?: (ms: number) => Promise<void>; transfer?: TransferJob; job?: Job; envPath?: string } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'transfer-'));
  if (over.transfer) writeFileSync(path.join(dataDir, 'transfer.json'), JSON.stringify(over.transfer));
  if (over.job) writeFileSync(path.join(dataDir, 'rebalance.json'), JSON.stringify(over.job));
  const store = new Store(':memory:');
  const getClients = () => makeClients({ key: TEST_KEY, secret: TEST_SECRET });
  const jobs = new JobFile(dataDir);
  const transfers = new TransferFile(dataDir);
  let parked = false;
  const park = (): Promise<void> => {
    parked = true;
    return new Promise<void>(() => undefined);
  };
  const sleep = over.sleep ?? park;
  const app = makeTestApp({
    getClients,
    engine: { store, venue: gateVenue(getClients), clock: { now: () => Date.now() } },
    rebalance: { jobs, sleep },
    transfer: { jobs: transfers, sleep },
    ...(over.envPath ? { credentials: { envPath: over.envPath, setClients: () => undefined } } : {}),
  });
  apps.push(app);
  return {
    app,
    store,
    jobs,
    transfers,
    parked: () => parked,
    file: () => JSON.parse(readFileSync(path.join(dataDir, 'transfer.json'), 'utf8')) as TransferJob,
    view: async () => (await app.inject({ method: 'GET', url: '/api/transfer', headers: HOST })).json(),
    post: (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/transfer', headers: HOST, payload }),
  };
}

describe('GET /api/transfer', () => {
  it('spot 403 is null', async () => {
    const t = boot();
    mockReads({
      spot: { status: 403, body: { label: 'FORBIDDEN', message: 'Request API key does not have spot permission' } },
    });

    const res = await t.app.inject({ method: 'GET', url: '/api/transfer', headers: HOST });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.spot).toBeNull();
    expect(data.paths.filter((p: { from: string }) => p.from === 'SPOT').map((p: { max: unknown }) => p.max)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('spot lists USDT and USDC', async () => {
    const t = boot();
    mockReads({
      spot: {
        body: [
          { currency: 'BTC', available: '0.01', locked: '0' },
          { currency: 'USDT', available: '288.70', locked: '0' },
          { currency: 'USDC', available: '0', locked: '0' },
        ],
      },
    });

    const { data } = await t.view();

    expect(data.spot).toEqual([
      { coin: 'USDT', available: 288.7, locked: 0 },
      { coin: 'USDC', available: 0, locked: 0 },
    ]);
  });

  it('missing USDC row is 0', async () => {
    const t = boot();
    mockReads({ spot: { body: [{ currency: 'USDT', available: '318.42', locked: '0' }] } });

    const { data } = await t.view();

    expect(data.spot).toEqual([
      { coin: 'USDT', available: 318.42, locked: 0 },
      { coin: 'USDC', available: 0, locked: 0 },
    ]);
  });

  it('lock while rebalance runs', async () => {
    const t = boot();
    await t.app.ready();
    t.jobs.write(rebalanceJob('running'));
    mockReads();

    const { data } = await t.view();

    expect(data.lock).toBe('rebalance');
  });

  it('lock while a deal is working', async () => {
    const t = boot();
    createWorkingDeal(t.store);
    mockReads();

    const { data } = await t.view();

    expect(data.lock).toBe('deal');
  });

  it('lock while rebalance halted', async () => {
    const t = boot({ job: rebalanceJob('halted') });
    mockReads();

    const { data } = await t.view();

    expect(data.lock).toBe('halted');
  });

  it('the view leaves out the tag, the venue id and the account', async () => {
    const t = boot();
    await t.app.ready();
    t.transfers.write(movingTransfer({ venueId: '123', sentAt: Date.now(), acceptedAt: Date.now() }));
    mockReads();

    const { data } = await t.view();

    expect(Object.keys(data.transfer).sort()).toEqual(
      ['id', 'coin', 'from', 'to', 'amount', 'status', 'received', 'failText', 'createdAt', 'doneAt'].sort(),
    );
    expect(data.transfer).toMatchObject({ coin: 'USDC', amount: 11.88, status: 'moving' });
  });
});

describe('POST /api/transfer refusals', () => {
  it('disclaimer first', async () => {
    const envPath = path.join(mkdtempSync(path.join(tmpdir(), 'env-')), '.env');
    const t = boot({ envPath });
    const calls = mockReads();

    const res = await t.post(HL_OUT);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.label).toBe('DISCLAIMER_NOT_ACCEPTED');
    expect(calls).toEqual({ account: 0, coins: 0, spot: 0 });
  });

  it('refuses a path not in the table', async () => {
    const t = boot();
    const calls = mockReads();

    const res = await t.post({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'CROSSEX_GATE', amount: '12' });

    expect(res.statusCode).toBe(400);
    expect(calls).toEqual({ account: 0, coins: 0, spot: 0 });
  });

  it('refuses a bad amount', async () => {
    const t = boot();
    const calls = mockReads();
    const sent = mockSend();

    for (const amount of ['abc', '-5', 0]) {
      const res = await t.post({ coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount });
      expect(res.statusCode, String(amount)).toBe(400);
    }

    expect(calls).toEqual({ account: 0, coins: 0, spot: 0 });
    expect(sent).toHaveLength(0);
  });

  it('refuses while rebalance halted', async () => {
    const t = boot({ job: rebalanceJob('halted') });
    mockReads();

    const res = await t.post(HL_OUT);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Transfers wait until you resume or abandon the rebalance.');
  });

  it('refuses while a deal is working', async () => {
    const t = boot();
    createWorkingDeal(t.store);
    mockReads();

    const res = await t.post(HL_OUT);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Transfers wait until the deal ends.');
  });

  it('refuses a second transfer', async () => {
    const t = boot();
    await t.app.ready();
    t.transfers.write(movingTransfer());
    mockReads();

    const res = await t.post({ coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount: '5' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('A transfer is still moving.');
  });

  it('refuses over max', async () => {
    const t = boot();
    mockReads();
    const sent = mockSend();

    const res = await t.post({ coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount: '900' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Max 813.19 USDT. The rest is margin for open positions.');
    expect(sent).toHaveLength(0);
  });

  it('refuses over the Gate spot balance', async () => {
    const t = boot();
    mockReads();

    const res = await t.post({ coin: 'USDT', from: 'SPOT', to: 'CROSSEX', amount: '400' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Max 318.42 USDT. That is your Gate spot balance.');
  });

  it('refuses under minimum', async () => {
    const t = boot();
    mockReads();

    const res = await t.post({ coin: 'USDC', from: 'SPOT', to: 'CROSSEX_HYPERLIQUID', amount: '10' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Minimum 11 USDC.');
  });

  it('post reads the account fresh', async () => {
    const t = boot();
    const calls = mockReads();
    mockSend();
    mockRows('PENDING');
    await t.view();
    expect(calls.account).toBe(1);

    const res = await t.post(HL_OUT);

    expect(res.statusCode).toBe(202);
    expect(calls.account).toBe(2);
    await waitFor(t.parked, 'the runner poll');
  });

  it('refuses a stale account read', async () => {
    const t = boot();
    const calls = mockReads({ accountThen429: true });
    const sent = mockSend();
    await t.view();

    for (const body of [HL_OUT, { coin: 'USDT', from: 'SPOT', to: 'CROSSEX', amount: '5' }]) {
      const res = await t.post(body);
      expect(res.statusCode, body.from).toBe(409);
      expect(res.json().error.message).toBe('Gate is rate-limiting the account read. Try again in a few seconds.');
    }

    expect(calls.account).toBe(3);
    expect(sent).toHaveLength(0);
    expect(t.transfers.read()).toBeNull();
  });

  it('refuses a stale spot read on a path from spot', async () => {
    const t = boot();
    const calls = mockReads({ spotThen429: true });
    const sent = mockSend();
    await t.view();

    const res = await t.post({ coin: 'USDT', from: 'SPOT', to: 'CROSSEX', amount: '5' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Gate is rate-limiting the account read. Try again in a few seconds.');
    expect(calls.spot).toBe(2);
    expect(sent).toHaveLength(0);
    expect(t.transfers.read()).toBeNull();
  });

  it('deal created during the transfer read', async () => {
    const t = boot();
    mockReads({ onAccountRead: () => createWorkingDeal(t.store) });
    const sent = mockSend();

    const res = await t.post(HL_OUT);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('Transfers wait until the deal ends.');
    expect(sent).toHaveLength(0);
    expect(t.transfers.read()).toBeNull();
  });
});

describe('POST /api/transfer sends', () => {
  it('sends one tagged transfer', async () => {
    const t = boot({ sleep: noWait });
    mockReads();
    const sent = mockSend();
    mockRows('SUCCESS', { actual_receive: '10.88' });

    const res = await t.post(HL_OUT);

    expect(res.statusCode).toBe(202);
    await waitFor(() => t.transfers.read()?.status === 'done', 'the transfer end');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ coin: 'USDC', amount: '11.88', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT' });
    expect(String(sent[0].text).startsWith('t-tr')).toBe(true);
    expect(res.json().data).toEqual({ id: t.file().id });
  });

  it('floors the amount to the transfer step', async () => {
    const t = boot({ sleep: noWait });
    mockReads();
    const sent = mockSend();
    mockRows('SUCCESS', { actual_receive: '10.88' });

    const res = await t.post({ ...HL_OUT, amount: '11.123456' });

    expect(res.statusCode).toBe(202);
    await waitFor(() => t.transfers.read()?.status === 'done', 'the transfer end');
    expect(sent[0].amount).toBe('11.12345');
  });

  it('sends exponent text as a plain decimal', async () => {
    const t = boot({ sleep: noWait });
    mockReads();
    const sent = mockSend();
    mockRows('SUCCESS', { actual_receive: '11.99' });

    const res = await t.post({ coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount: '1.2e1' });

    expect(res.statusCode).toBe(202);
    await waitFor(() => t.transfers.read()?.status === 'done', 'the transfer end');
    expect(sent[0].amount).toBe('12');
  });

  it('writes moving', async () => {
    const t = boot();
    mockReads();
    mockSend();
    mockRows('PENDING');

    const res = await t.post(HL_OUT);

    expect(res.statusCode).toBe(202);
    expect(t.file()).toMatchObject({
      status: 'moving',
      coin: 'USDC',
      from: 'CROSSEX_HYPERLIQUID',
      to: 'SPOT',
      amount: 11.88,
      userId: '1',
    });
    await waitFor(t.parked, 'the runner poll');
    expect(t.file().status).toBe('moving');
  });

  it('accept busts the account cache', async () => {
    const t = boot();
    const calls = mockReads();
    mockSend();
    mockRows('PENDING');

    const res = await t.post(HL_OUT);
    expect(res.statusCode).toBe(202);
    await waitFor(t.parked, 'the runner poll');
    expect(t.file().venueId).toBe('123');
    expect(calls.account).toBe(1);

    const accountRes = await t.app.inject({ method: 'GET', url: '/api/account', headers: HOST });

    expect(accountRes.statusCode).toBe(200);
    expect(calls.account).toBe(2);
  });

  it('refused send fails', async () => {
    const t = boot({ sleep: noWait });
    mockReads();
    mockSend({
      status: 422,
      body: { label: 'TRANSFER_AMOUNT_INSUFFICIENT', message: 'Insufficient transferAvailable, transferAvailable: 11.85' },
    });

    const res = await t.post(HL_OUT);

    expect(res.statusCode).toBe(202);
    await waitFor(() => t.transfers.read()?.status !== 'moving', 'the refusal');
    expect(t.file()).toMatchObject({ status: 'failed', failText: HALT_TEXT.marginRefused });
    expect(t.file().failText).toBe('Gate refused the move: free margin is too low.');
  });

  it('boot polls a moving transfer', async () => {
    const now = Date.now();
    const t = boot({
      sleep: noWait,
      transfer: movingTransfer({ venueId: '123', sentAt: now - 5_000, acceptedAt: now - 4_000 }),
    });
    const sent = mockSend();
    mockRows('SUCCESS', { actual_receive: '10.88' });

    await t.app.ready();

    await waitFor(() => t.file().status === 'done', 'the boot poll');
    expect(t.file()).toMatchObject({ status: 'done', received: 10.88, venueId: '123' });
    expect(sent).toHaveLength(0);
  });
});

describe('POST /api/transfer races', () => {
  it('one of two transfer posts', async () => {
    const t = boot();
    mockReads({ delayMs: 50 });
    const sent = mockSend();
    mockRows('PENDING');

    const results = await Promise.all([t.post(HL_OUT), t.post(HL_OUT)]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json().error.message).toBe(LOCK_TEXT.moving);
    await waitFor(t.parked, 'the runner poll');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(1);
    expect(t.file().venueId).toBe('123');
  });

  it('rebalance and transfer race', async () => {
    const t = boot();
    mockReads({ delayMs: 50 });
    mockSend();
    mockRows('PENDING');
    mockGateGet('/interest_rate', {
      body: [{ coin: 'USDC', exchange_type: 'HYPERLIQUID', hour_interest_rate: '0.000005', time: String(Date.now()) }],
    });
    mockGateGet('/history_margin_interests', { body: [] });
    mockGateGet('/rule/symbols', {
      body: [{ symbol: 'GATE_SPOT_USDC_USDT', exchange_type: 'GATE', business_type: 'SPOT', state: 'live' }],
    });
    mockGateGet('/fee', { fixture: 'fee.json' });
    gate()
      .persist()
      .get(`${API}/spot/tickers`)
      .query(true)
      .reply(200, [{ currency_pair: 'USDC_USDT', lowest_ask: '1.0001', highest_bid: '0.9999', last: '1' }]);

    const results = await Promise.all([
      t.app.inject({ method: 'POST', url: '/api/rebalance', headers: HOST, payload: { route: 'convert' } }),
      t.post({ coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount: '5' }),
    ]);

    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join('\n')).toEqual([202, 409]);
    const started = [t.jobs.read() !== null, t.transfers.read() !== null];
    expect(started.filter(Boolean)).toHaveLength(1);
    await waitFor(() => t.parked() || t.jobs.read()?.status === 'halted', 'the started run to wait on Gate');
  });
});
