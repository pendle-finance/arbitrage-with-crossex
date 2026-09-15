import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CrossexOrderRequest, type CrossexAccountAsset, type CrossexTransferRecord } from 'gate-api';
import { describe, expect, it } from 'vitest';
import type { Clients } from '../../src/core/clients';
import { classifyGateError } from '../../src/core/errors';
import {
  CONVERT_RATE,
  DUST_USDC,
  HYPERLIQUID_DEPOSIT_FEE_USD,
  nearestCents,
  SPOT_SYMBOL,
  TO_USDC_WAIT_SECONDS,
  type GateAccount,
  type PlannedStep,
  type TransferCoin,
} from '../../src/core/rebalance/plan';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { buildApp } from '../../src/server/app';
import { TtlCache } from '../../src/server/cache';
import {
  JobFile,
  newJob,
  newTransferJob,
  TransferFile,
  type Job,
  type TransferJob,
} from '../../src/server/rebalanceJob';
import { POLL_MS, QUOTE_FLOOR, runJob, runTransfer, tagFor, TRANSFER_STEP } from '../../src/server/rebalanceRunner';
import { sleep } from '../../src/server/routes/rebalance';
import { budget, runId } from './env';
import { assertAck, assertCredentials, assertLiveTestsEnabled } from './guards';

const ROUND = 12;
const PROBE_USDT = 1;
const CONVERT_USDC = 11;
const SETUP_BUY_USDT = 4;
const UNDER_STEP = 0.000001;
const MOVE_WAIT_MS = 180_000;
const RESTART_WAIT_MS = 150_000;
const SETUP_WAIT_MS = 30_000;
const PROBE_AT_MS = [5_000, 70_000, 150_000];
const TOKEN = 'live-rebalance-token';

type CrossEx = Clients['crossEx'];
type JobInput = Omit<Parameters<typeof newJob>[0], 'target' | 'userId'>;
type TransferLeg = { coin: TransferCoin; from: GateAccount; to: GateAccount; amount: number };
type Posted = { statusCode: number; transfer: TransferJob | null };
type Watch = { text: string; since: number };
type SentOrder = { key: string; orderId: string; at: number };
type Call = { key: string; seconds: number };
type Booted = { jobs: JobFile; job: Job };

const CONVERT_STEP: PlannedStep = {
  round: null,
  kind: 'convert',
  buy: 0,
  move: ROUND,
  arrives: 11.97,
  borrowLeft: 0,
  seconds: 0,
};

const CONVERT_USDC_STEP: PlannedStep = {
  ...CONVERT_STEP,
  move: CONVERT_USDC,
  arrives: nearestCents(CONVERT_USDC * (1 - CONVERT_RATE)),
};

const row = (list: CrossexAccountAsset[], coin: string, venue: string) =>
  list.find((a) => a.coin === coin && a.exchangeType === venue);

const balanceOf = (list: CrossexAccountAsset[], coin: string, venue: string): number =>
  Number(row(list, coin, venue)?.balance ?? 0);

const readAssets = async (clients: Clients): Promise<CrossexAccountAsset[]> =>
  (await clients.crossEx.getCrossexAccount()).body.assets ?? [];

const formatBalances = (list: CrossexAccountAsset[], coin: string): string =>
  list
    .filter((a) => a.coin === coin)
    .map((a) => `${coin}/${a.exchangeType}=${a.balance}`)
    .join(' ');

const logBalances = (label: string, list: CrossexAccountAsset[]): void =>
  console.log(`  ▸ ${label} ${formatBalances(list, 'USDT')} ${formatBalances(list, 'USDC')}`);

const secondsSince = (at: number): number => Math.round((Date.now() - at) / 1000);

const planRound = (n: number, liability: number): PlannedStep => ({
  round: n,
  kind: 'round',
  buy: ROUND,
  move: ROUND,
  arrives: ROUND - HYPERLIQUID_DEPOSIT_FEE_USD,
  borrowLeft: Math.max(0, liability - n * (ROUND - HYPERLIQUID_DEPOSIT_FEE_USD)),
  seconds: TO_USDC_WAIT_SECONDS,
});

const logJob = (job: Job): void => {
  console.log(`  ▸ job ${job.id}: ${job.status}${job.haltReason ? ` (${job.haltReason})` : ''} fundsAt=${job.fundsAt}`);
  for (const step of job.steps) {
    console.log(`  ▸ round ${step.round} ${step.name}: status=${step.status} venueId=${step.venueId} qty=${step.qty}`);
  }
};

const withCrossEx = (clients: Clients, overrides: Partial<CrossEx>): Clients => ({
  ...clients,
  crossEx: new Proxy(clients.crossEx, {
    get: (target, name, receiver) => Reflect.get(Object.hasOwn(overrides, name) ? overrides : target, name, receiver),
  }),
});

const readOrder = async (crossEx: CrossEx, key: string, since: number) => {
  try {
    const read = await crossEx.getCrossexOrder(key);
    const { orderId, state, text } = read.body;
    console.log(`  ▸ +${secondsSince(since)} s order ${key}: found orderId=${orderId} state=${state} text=${text}`);
    return read;
  } catch (err) {
    const { label, category, httpStatus } = classifyGateError(err);
    console.log(`  ▸ +${secondsSince(since)} s order ${key}: ${label ?? category} HTTP ${httpStatus ?? 'none'}`);
    throw err;
  }
};

const probeAfterOrder = async (crossEx: CrossEx, order: SentOrder): Promise<void> => {
  for (const offset of PROBE_AT_MS) {
    await sleep(Math.max(0, order.at + offset - Date.now()));
    await readOrder(crossEx, order.key, order.at).catch(() => null);
  }
  await readOrder(crossEx, order.orderId, order.at).catch(() => null);
};

const logTransferLookups =
  (crossEx: CrossEx, watch: Watch): CrossEx['listCrossexTransfers'] =>
  async (opts) => {
    const read = await crossEx.listCrossexTransfers(opts);
    const match = (read.body ?? []).find((r) => r.text === watch.text);
    const found = match ? `id=${match.id} status=${match.status}` : 'no row';
    console.log(`  ▸ +${secondsSince(watch.since)} s transfer lookup ${watch.text}: ${found}`);
    return read;
  };

const tagRows = async (clients: Clients, text: string): Promise<CrossexTransferRecord[]> => {
  const { body } = await clients.crossEx.listCrossexTransfers({ coin: 'USDT', limit: 100 });
  const tagged = (body ?? []).filter((r) => r.text === text);
  const listed = tagged.map((r) => `id=${r.id} status=${r.status}`).join(', ') || 'none';
  console.log(`  ▸ Gate USDT rows with text ${text}: ${listed}`);
  return tagged;
};

const postTransfer = async (clients: Clients, leg: TransferLeg): Promise<Posted> => {
  const { coin, from, to, amount } = leg;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-live-'));
  const transfers = new TransferFile(dataDir);
  const app = buildApp({
    getClients: () => clients,
    cache: new TtlCache(),
    authToken: TOKEN,
    engine: { store: new Store(':memory:'), venue: gateVenue(() => clients), clock: { now: Date.now } },
    transfer: { jobs: transfers, sleep },
  });
  try {
    const before = await readAssets(clients);
    const res = await app.inject({
      method: 'POST',
      url: '/api/transfer',
      headers: { host: 'localhost:6688', 'x-arb-token': TOKEN },
      payload: { coin, from, to, amount: String(amount) },
    });
    console.log(`  ▸ POST ${amount} ${coin} ${from} to ${to}: HTTP ${res.statusCode} ${res.body}`);
    if (res.statusCode !== 202) return { statusCode: res.statusCode, transfer: null };
    const deadline = Date.now() + MOVE_WAIT_MS;
    while (transfers.read()?.status === 'moving') {
      if (Date.now() > deadline) throw new Error(`${coin} ${from} to ${to} still moving after ${MOVE_WAIT_MS / 1000} s`);
      await sleep(POLL_MS);
    }
    const transfer = transfers.read();
    if (!transfer) throw new Error(`transfer.json in ${dataDir} is unreadable`);
    const after = await readAssets(clients);
    console.log(
      `  ▸ ${coin} ${from} to ${to}: ${transfer.status} venueId=${transfer.venueId} received=${transfer.received} failText=${transfer.failText}`,
    );
    console.log(`  ▸ before ${formatBalances(before, coin)} after ${formatBalances(after, coin)}`);
    return { statusCode: res.statusCode, transfer: { ...transfer } };
  } finally {
    await app.close();
  }
};

const moveDone = async (clients: Clients, leg: TransferLeg): Promise<TransferJob> => {
  const { statusCode, transfer } = await postTransfer(clients, leg);
  if (!transfer) throw new Error(`POST ${leg.coin} ${leg.from} to ${leg.to} answered HTTP ${statusCode}`);
  expect(transfer.status, transfer.failText ?? '').toBe('done');
  return transfer;
};

const runLogged = async ({ jobs, job }: Booted, clients: Clients): Promise<void> => {
  await runJob({
    clients: () => clients,
    jobs,
    cache: new TtlCache(),
    now: Date.now,
    sleep,
    onHalt: (halted) => console.error(`  ▸ halted: ${halted.haltReason}`),
  });
  logJob(job);
};

const runLiveJob = async (clients: Clients, input: JobInput): Promise<Job> => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebalance-live-'));
  const jobs = new JobFile(dataDir);
  const job = newJob({ ...input, target: [], userId: null }, Date.now());
  jobs.write(job);
  console.log(`  ▸ job ${job.id} written to ${dataDir}`);
  await runLogged({ jobs, job }, clients);
  return job;
};

const writeRunningJob = (input: JobInput) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebalance-recovery-'));
  const jobs = new JobFile(dataDir);
  const job = newJob({ ...input, target: [], userId: null }, Date.now());
  const [step] = job.steps;
  const tag = tagFor(job.id, 0, step.attempt);
  step.startedAt = Date.now();
  step.status = 'running';
  step.text = tag;
  jobs.write(job);
  console.log(`  ▸ job ${job.id} step ${step.name} text=${tag} written to ${dataDir}`);
  return { dataDir, jobs, job, tag };
};

const bootHalt = (dataDir: string): Booted => {
  const jobs = new JobFile(dataDir);
  const halted = jobs.haltIfRunning();
  const job = jobs.read();
  if (!job) throw new Error(`rebalance.json in ${dataDir} is unreadable`);
  const [step] = job.steps;
  console.log(
    `  ▸ boot halted=${halted}: ${job.status} (${job.haltReason}) ${step.name} text=${step.text} quoteId=${step.quoteId} venueId=${step.venueId}`,
  );
  return { jobs, job };
};

const resumeLikeRoute = async (booted: Booted, clients: Clients, orderAt: number): Promise<void> => {
  const { jobs, job } = booted;
  job.status = 'running';
  job.haltReason = null;
  job.steps[job.stepIndex].startedAt = Date.now();
  jobs.write(job);
  console.log(`  ▸ Resume at +${secondsSince(orderAt)} s`);
  await runLogged(booted, clients);
};

const logCalls = (label: string, calls: Call[]): void =>
  console.log(`  ▸ ${label} calls: ${calls.map((call) => `${call.key} at +${call.seconds} s`).join(', ') || 'none'}`);

describe.skipIf(process.env.REBALANCE !== '1')('live rebalance recovery and transfer edge cases', () => {
  it('transfer lost response: the tag finds it and nothing is sent twice', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const cashBefore = balanceOf(before, 'USDT', 'CROSSEX');
    if (!(cashBefore > PROBE_USDT)) {
      throw new Error(`USDT/CROSSEX balance ${cashBefore} is not above ${PROBE_USDT}. Nothing to move.`);
    }

    budget.beforeOrder(PROBE_USDT, 'transfer lost response');

    const sends: string[] = [];
    const watch: Watch = { text: '', since: Date.now() };
    const lossy = withCrossEx(clients, {
      createCrossexTransfer: async (opts) => {
        watch.text = opts?.crossexTransferRequest?.text ?? '';
        watch.since = Date.now();
        sends.push(watch.text);
        const { body } = await clients.crossEx.createCrossexTransfer(opts);
        console.log(`  ▸ Gate took transfer txId=${body.txId} text=${body.text}. The app gets socket hang up.`);
        throw new Error('socket hang up');
      },
      listCrossexTransfers: logTransferLookups(clients.crossEx, watch),
    });

    const out = await moveDone(lossy, { coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount: PROBE_USDT });
    const tagged = await tagRows(clients, out.text);
    await moveDone(clients, { coin: 'USDT', from: 'SPOT', to: 'CROSSEX', amount: PROBE_USDT });
    const after = await readAssets(clients);
    logBalances('after', after);

    expect(sends).toHaveLength(1);
    expect(tagged).toHaveLength(1);
    expect(String(tagged[0]?.id)).toBe(out.venueId);
    expect(Math.abs(balanceOf(after, 'USDT', 'CROSSEX') - cashBefore)).toBeLessThanOrEqual(0.01);
  }, 3 * MOVE_WAIT_MS);

  it('transfer restart after Gate took it: found by tag after 150 s', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const account = (await clients.crossEx.getCrossexAccount()).body;
    const before = account.assets ?? [];
    logBalances('before', before);
    const cashBefore = balanceOf(before, 'USDT', 'CROSSEX');
    if (!(cashBefore > PROBE_USDT)) {
      throw new Error(`USDT/CROSSEX balance ${cashBefore} is not above ${PROBE_USDT}. Nothing to move.`);
    }

    budget.beforeOrder(PROBE_USDT, 'transfer restart');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-live-'));
    const userId = account.userId ? String(account.userId) : null;
    const transfer = newTransferJob({ coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount: PROBE_USDT, userId }, Date.now());
    transfer.sentAt = Date.now();
    new TransferFile(dataDir).write(transfer);
    const { coin, amount, from, to, text } = transfer;
    const { body } = await clients.crossEx.createCrossexTransfer({
      crossexTransferRequest: { coin, amount: String(amount), from, to, text },
    });
    const txId = String(body.txId);
    const sentAt = Date.now();
    console.log(`  ▸ Gate took transfer txId=${txId} text=${body.text}. transfer.json in ${dataDir} keeps venueId null.`);

    await sleep(RESTART_WAIT_MS);

    const sends: string[] = [];
    const counting = withCrossEx(clients, {
      createCrossexTransfer: (opts) => {
        sends.push(opts?.crossexTransferRequest?.text ?? '');
        return clients.crossEx.createCrossexTransfer(opts);
      },
      listCrossexTransfers: logTransferLookups(clients.crossEx, { text, since: sentAt }),
    });
    const transfers = new TransferFile(dataDir);
    await runTransfer({ clients: () => counting, transfers, cache: new TtlCache(), now: Date.now, sleep });
    const booted = transfers.read();
    console.log(
      `  ▸ runTransfer at +${secondsSince(sentAt)} s: ${booted?.status} venueId=${booted?.venueId} received=${booted?.received} failText=${booted?.failText}`,
    );

    const tagged = await tagRows(clients, text);
    await moveDone(clients, { coin: 'USDT', from: 'SPOT', to: 'CROSSEX', amount: PROBE_USDT });
    const after = await readAssets(clients);
    logBalances('after', after);

    expect(booted?.status).toBe('done');
    expect(sends).toHaveLength(0);
    expect(booted?.venueId).toBe(txId);
    expect(tagged).toHaveLength(1);
    expect(Math.abs(balanceOf(after, 'USDT', 'CROSSEX') - cashBefore)).toBeLessThanOrEqual(0.01);
  }, RESTART_WAIT_MS + 3 * MOVE_WAIT_MS);

  it('order step restart past 60 s: Resume finds the Buy USDC and sends no second order', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const cash = balanceOf(before, 'USDT', 'CROSSEX');
    if (!(cash > 2 * ROUND)) {
      throw new Error(`USDT/CROSSEX balance ${cash} is not above ${2 * ROUND}. A failing run buys twice.`);
    }
    const liability = Number(row(before, 'USDC', 'HYPERLIQUID')?.liability ?? 0);

    budget.beforeOrder(2 * ROUND, 'Buy USDC restart');

    const { dataDir, tag } = writeRunningJob({
      direction: 'toUsdc',
      route: 'loop',
      steps: [planRound(1, liability)],
      amount: ROUND,
      costUsd: HYPERLIQUID_DEPOSIT_FEE_USD,
    });
    const { body } = await clients.crossEx.createCrossexOrder({
      crossexOrderRequest: {
        symbol: SPOT_SYMBOL,
        side: CrossexOrderRequest.Side.BUY,
        type: CrossexOrderRequest.Type.MARKET,
        quoteQty: String(ROUND),
        text: tag,
      },
    });
    const order: SentOrder = { key: tag, orderId: String(body.orderId), at: Date.now() };
    console.log(`  ▸ Buy USDC orderId=${order.orderId} text=${body.text}. rebalance.json keeps venueId null.`);

    const booted = bootHalt(dataDir);
    await probeAfterOrder(clients.crossEx, order);

    const orders: Call[] = [];
    const counting = withCrossEx(clients, {
      createCrossexOrder: (opts) => {
        orders.push({ key: opts?.crossexOrderRequest?.text ?? '', seconds: secondsSince(order.at) });
        return clients.crossEx.createCrossexOrder(opts);
      },
      getCrossexOrder: (key) => readOrder(clients.crossEx, key, order.at),
    });
    await resumeLikeRoute(booted, counting, order.at);
    logBalances('after', await readAssets(clients));
    logCalls('createCrossexOrder', orders);

    const again = orders.filter((call) => call.key === tag);
    expect(again.length, `Resume sent Buy USDC a second time ${again[0]?.seconds} s after the order`).toBe(0);
    expect(booted.job.steps[0].venueId).toBe(order.orderId);
  }, 900_000);

  it('Convert restart past 60 s: Resume finds the Convert and converts nothing twice', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const usdc = row(before, 'USDC', 'HYPERLIQUID');
    const cash = Number(usdc?.balance ?? 0);
    const equity = Number(usdc?.equity ?? 0);
    if (!(cash >= CONVERT_USDC && equity >= CONVERT_USDC)) {
      throw new Error(`USDC/HYPERLIQUID cash ${cash} or equity ${equity} is under ${CONVERT_USDC}. Nothing to convert.`);
    }

    budget.beforeOrder(2 * CONVERT_USDC, 'Convert restart');

    const { dataDir, jobs, job, tag } = writeRunningJob({
      direction: 'toUsdt',
      route: 'convert',
      steps: [CONVERT_USDC_STEP],
      amount: CONVERT_USDC,
      costUsd: nearestCents(CONVERT_USDC * CONVERT_RATE),
    });
    const { body: quote } = await clients.crossEx.createCrossexConvertQuote({
      crossexConvertQuoteRequest: {
        exchangeType: 'HYPERLIQUID',
        fromCoin: 'USDC',
        toCoin: 'USDT',
        fromAmount: String(CONVERT_USDC),
      },
    });
    console.log(`  ▸ quote quoteId=${quote.quoteId} ${quote.fromAmount} USDC to ${quote.toAmount} USDT validMs=${quote.validMs}`);
    const toAmount = Number(quote.toAmount);
    if (!(toAmount >= CONVERT_USDC * QUOTE_FLOOR)) {
      throw new Error(`Convert quote ${quote.toAmount} USDT for ${CONVERT_USDC} USDC is under the quote floor. Nothing was sent.`);
    }
    const quoteId = String(quote.quoteId);
    job.steps[0].quoteId = quoteId;
    job.steps[0].qty = toAmount;
    jobs.write(job);
    const { body } = await clients.crossEx.createCrossexConvertOrder({ crossexConvertOrderRequest: { quoteId } });
    const order: SentOrder = { key: quoteId, orderId: String(body.orderId), at: Date.now() };
    console.log(`  ▸ Convert orderId=${order.orderId} text=${body.text} step text=${tag}. rebalance.json keeps venueId null.`);

    const booted = bootHalt(dataDir);
    await probeAfterOrder(clients.crossEx, order);

    const quotes: Call[] = [];
    const converts: Call[] = [];
    const counting = withCrossEx(clients, {
      createCrossexConvertQuote: (opts) => {
        quotes.push({ key: opts?.crossexConvertQuoteRequest?.fromAmount ?? '', seconds: secondsSince(order.at) });
        return clients.crossEx.createCrossexConvertQuote(opts);
      },
      createCrossexConvertOrder: (opts) => {
        converts.push({ key: opts?.crossexConvertOrderRequest?.quoteId ?? '', seconds: secondsSince(order.at) });
        return clients.crossEx.createCrossexConvertOrder(opts);
      },
      getCrossexOrder: (key) => readOrder(clients.crossEx, key, order.at),
    });
    await resumeLikeRoute(booted, counting, order.at);
    logBalances('after', await readAssets(clients));
    logCalls('createCrossexConvertQuote', quotes);
    logCalls('createCrossexConvertOrder', converts);

    expect(converts.length, `Resume converted a second time ${converts[0]?.seconds} s after the Convert`).toBe(0);
    expect(quotes).toHaveLength(0);
    expect(booted.job.steps[0].venueId).toBe(order.orderId);
  }, 600_000);

  it('amounts under the 0.00001 transfer step: what Gate answers', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const gateUsdc = balanceOf(before, 'USDC', 'GATE');

    budget.beforeOrder(2 * UNDER_STEP, 'transfers under the step');

    const legs: TransferLeg[] = [{ coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount: UNDER_STEP }];
    if (gateUsdc < UNDER_STEP) {
      console.log(`  ▸ USDC/GATE cash ${gateUsdc} is under ${UNDER_STEP}. The USDC leg is skipped.`);
    } else {
      legs.push({ coin: 'USDC', from: 'CROSSEX_GATE', to: 'SPOT', amount: UNDER_STEP });
    }
    const watch: Watch = { text: '', since: Date.now() };
    const recording = withCrossEx(clients, {
      createCrossexTransfer: async (opts) => {
        const request = opts?.crossexTransferRequest;
        watch.text = request?.text ?? '';
        watch.since = Date.now();
        try {
          const read = await clients.crossEx.createCrossexTransfer(opts);
          console.log(`  ▸ Gate took amount=${request?.amount} ${request?.coin}: txId=${read.body.txId}`);
          return read;
        } catch (err) {
          const { label, category, httpStatus, message } = classifyGateError(err);
          console.log(`  ▸ Gate answered amount=${request?.amount} ${request?.coin}: ${label ?? category} HTTP ${httpStatus ?? 'none'} ${message}`);
          throw err;
        }
      },
      listCrossexTransfers: logTransferLookups(clients.crossEx, watch),
    });
    for (const leg of legs) await postTransfer(recording, leg);

    const after = await readAssets(clients);
    logBalances('after', after);
    const wallets = new Map(
      [...before, ...after]
        .filter((asset) => asset.coin === 'USDT' || asset.coin === 'USDC')
        .map((asset): [string, CrossexAccountAsset] => [`${asset.coin}/${asset.exchangeType}`, asset]),
    );
    for (const { coin = '', exchangeType = '' } of wallets.values()) {
      const moved = balanceOf(after, coin, exchangeType) - balanceOf(before, coin, exchangeType);
      expect(Math.abs(moved), `${coin}/${exchangeType} moved ${moved}`).toBeLessThanOrEqual(Number(TRANSFER_STEP));
    }
  }, 3 * MOVE_WAIT_MS);

  it('Convert toward USDC sells the Gate wallet USDC first', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const cash = balanceOf(before, 'USDT', 'CROSSEX');
    if (!(cash > SETUP_BUY_USDT + ROUND)) {
      throw new Error(`USDT/CROSSEX balance ${cash} is not above ${SETUP_BUY_USDT + ROUND}. Not enough for the setup buy and a Convert.`);
    }

    budget.beforeOrder(SETUP_BUY_USDT + ROUND, 'Convert toward USDC after a Gate wallet buy');

    const { body } = await clients.crossEx.createCrossexOrder({
      crossexOrderRequest: {
        symbol: SPOT_SYMBOL,
        side: CrossexOrderRequest.Side.BUY,
        type: CrossexOrderRequest.Type.MARKET,
        quoteQty: String(SETUP_BUY_USDT),
        text: `lt-setup-${runId}`,
      },
    });
    console.log(`  ▸ setup Buy USDC orderId=${body.orderId} text=${body.text}`);
    const deadline = Date.now() + SETUP_WAIT_MS;
    let gateCash = balanceOf(await readAssets(clients), 'USDC', 'GATE');
    while (gateCash < DUST_USDC) {
      if (Date.now() > deadline) {
        throw new Error(`USDC/GATE cash ${gateCash} is still under ${DUST_USDC} ${SETUP_WAIT_MS / 1000} s after the setup buy.`);
      }
      await sleep(POLL_MS);
      gateCash = balanceOf(await readAssets(clients), 'USDC', 'GATE');
    }
    console.log(`  ▸ USDC/GATE cash ${gateCash} before the Convert job`);

    const job = await runLiveJob(clients, {
      direction: 'toUsdc',
      route: 'convert',
      steps: [CONVERT_STEP],
      amount: ROUND,
      costUsd: 0.03,
    });
    const after = await readAssets(clients);
    logBalances('after', after);
    console.log(`  ▸ Sell USDC qty ${job.steps.find((step) => step.name === 'Sell USDC')?.qty}`);

    expect(job.status).toBe('done');
    expect(job.steps.map((step) => step.name)).toEqual(['Sell USDC', 'Convert']);
    for (const step of job.steps) {
      expect(step.status).toBe('done');
      expect(step.venueId).not.toBeNull();
    }
    expect(balanceOf(after, 'USDC', 'GATE')).toBeLessThan(DUST_USDC);
  }, 300_000);
});
