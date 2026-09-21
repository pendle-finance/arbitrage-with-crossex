import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CrossexOrderRequest, type CrossexAccountAsset, type CrossexOrder, type CrossexTransferRecord } from 'gate-api';
import { describe, expect, it } from 'vitest';
import type { Clients } from '../../src/core/clients';
import { classifyGateError } from '../../src/core/errors';
import {
  arrivesFor,
  CONVERT_RATE,
  DUST_USDC,
  floorCents,
  GATE_WALLET,
  HYPERLIQUID_DEPOSIT_FEE_USD,
  HYPERLIQUID_WITHDRAW_FEE_USD,
  LIGHTER_DEPOSIT_FEE_USD,
  LIGHTER_WALLET,
  nearestCents,
  poolWallet,
  roundSeconds,
  SPOT_MIN_QUOTE_USDT,
  SPOT_SYMBOL,
  spotArrivalFor,
  USDC_WALLET,
  USDT_WALLET,
  type GateAccount,
  type PlannedStep,
  type Pool,
  type TransferCoin,
  type Venue,
} from '../../src/core/rebalance/plan';
import { Store } from '../../src/engine/db';
import { decodeStatus } from '../../src/engine/loop';
import { gateVenue } from '../../src/engine/venueGate';
import { buildApp } from '../../src/server/app';
import { TtlCache } from '../../src/server/cache';
import {
  convertSteps,
  HALT_TEXT,
  inTransitOf,
  JobFile,
  newJob,
  TransferFile,
  type Job,
  type JobStatus,
  type Step,
  type StepName,
  type TransferJob,
} from '../../src/server/rebalanceJob';
import {
  HL_TRANSFER_TIMEOUT_MS,
  POLL_MS,
  quoteFloor,
  readSpotTicker,
  runJob,
  STEP_TIMEOUT_MS,
  STEPS,
  tagFor,
} from '../../src/server/rebalanceRunner';
import { sleep } from '../../src/server/routes/rebalance';
import { budget, HARD_NOTIONAL_CEILING_USDT, NOTIONAL, runId } from './env';
import { assertAck, assertCredentials, assertLiveTestsEnabled, assertNotionalCeiling } from './guards';

const ROUND = 12;
const USDC_ROUND_TRIP = 12.5;
const EXACT_MINIMUM_USDC = 11;
const HL_TO_LIGHTER_ROUND = 13;
const CONVERT_USDC = 11;
const SETUP_BUY_USDT = 4;
const GATE_CASH_MAX = 20;
const BORROW_OVER_EQUITY_USDC = 12;
const LIGHTER_TO_USDT_MIN = 11;
const HL_TO_LIGHTER_MIN = 12;
const HL_TO_LIGHTER_VAR = 'LIVE_HL_TO_LIGHTER';
const VENUE_PART = 12;
const USDT_PART = 6;
const LIGHTER_TO_USDT_VAR = 'LIVE_LIGHTER_TO_USDT';
const CONVERT_ARRIVES = 11.97;
const MIX_COST_USD = 1.08;
const CONVERT_COST_USD = 0.03;
const MARGIN_RATIO_MIN = 3;
const LIABILITY_MIN = 1;
const LIABILITY_LEFT = 0.01;
const RUN_BUDGET_NOTIONALS = 5;
const MOVE_TOLERANCE = 0.02;
const FEE_TOLERANCE = 0.01;
const CASH_TOLERANCE = 0.05;
const FILL_TOLERANCE = 0.05;
const MINIMUM_REFUSAL = /MINTRANS|MINIMUM/i;
const SWEEP_SKEW_MS = 600_000;
const HISTORY_LIMIT = 100;
const SLOW_WAIT_MS = 900_000;
const QUICK_WAIT_MS = 120_000;
const SETUP_WAIT_MS = 30_000;
const TOKEN = 'live-rebalance-token';
const HEADERS = { host: 'localhost:6688', 'x-arb-token': TOKEN };
const SLOW_WALLETS: readonly GateAccount[] = ['CROSSEX_HYPERLIQUID', 'CROSSEX_LIGHTER'];

type CrossEx = Clients['crossEx'];
type Account = Awaited<ReturnType<CrossEx['getCrossexAccount']>>['body'];
type WalletRef = { coin: string; venue: string };
type Move = { from: Pool; to: Pool };
type JobInput = Omit<Parameters<typeof newJob>[0], 'target' | 'userId'>;
type TransferLeg = { coin: TransferCoin; from: GateAccount; to: GateAccount; amount: number };
type Posted = { statusCode: number; body: string; transfer: TransferJob | null };
type Post = (leg: TransferLeg) => Promise<Posted>;
type Planned = Move & { name: StepName; round: number | null; symbol?: string };
type Ran = { job: Job; before: CrossexAccountAsset[]; after: CrossexAccountAsset[] };
type CallKind = 'transfer' | 'order' | 'quote' | 'convert' | 'history';
type Call = {
  kind: CallKind;
  key: string;
  to: string;
  amount: number;
  httpStatus: number | null;
  label: string | null;
  message: string | null;
  id?: string;
};
type LegOutcome = { outcome: 'done'; transfer: TransferJob; row: CrossexTransferRecord } | { outcome: 'refused' };

const newDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const readAccount = async (clients: Clients): Promise<Account> => (await clients.crossEx.getCrossexAccount()).body;

const readAssets = async (clients: Clients): Promise<CrossexAccountAsset[]> => (await readAccount(clients)).assets ?? [];

const userIdOf = (account: Account): string | null => (account.userId ? String(account.userId) : null);

const marginRatio = (account: Account): number => Number(account.marginBalance) / Number(account.initialMargin);

const row = (list: CrossexAccountAsset[], wallet: WalletRef) =>
  list.find((a) => a.coin === wallet.coin && a.exchangeType === wallet.venue);

const balanceOf = (list: CrossexAccountAsset[], wallet: WalletRef): number => Number(row(list, wallet)?.balance ?? 0);

const spareOf = (list: CrossexAccountAsset[], wallet: WalletRef): number => {
  const asset = row(list, wallet);
  return Math.min(Number(asset?.availableBalance ?? 0), Number(asset?.equity ?? 0));
};

const liabilityOf = (asset: CrossexAccountAsset | undefined): number => Number(asset?.liability ?? 0);

const changeOf = (before: CrossexAccountAsset[], after: CrossexAccountAsset[], wallet: WalletRef): number =>
  balanceOf(after, wallet) - balanceOf(before, wallet);

const qtyOf = (step: Step | undefined): number => step?.qty ?? 0;

const soldOf = (job: Job): number =>
  job.steps.filter((step) => step.name === 'Sell USDC').reduce((total, step) => total + qtyOf(step), 0);

const formatBalances = (list: CrossexAccountAsset[], coin: string): string =>
  list
    .filter((a) => a.coin === coin)
    .map((a) => `${coin}/${a.exchangeType}=${a.balance}`)
    .join(' ');

const logBalances = (label: string, list: CrossexAccountAsset[]): void =>
  console.log(`  ▸ ${label} ${formatBalances(list, 'USDT')} ${formatBalances(list, 'USDC')}`);

const logWallet = (label: string, list: CrossexAccountAsset[], wallet: WalletRef): void => {
  const asset = row(list, wallet);
  console.log(
    `  ▸ ${label} ${wallet.coin}/${wallet.venue} balance=${asset?.balance} availableBalance=${asset?.availableBalance} equity=${asset?.equity} liability=${asset?.liability} borrowingInitialMargin=${asset?.borrowingInitialMargin} borrowingMaintenanceMargin=${asset?.borrowingMaintenanceMargin}`,
  );
};

const expectNear = (label: string, actual: number, expected: number, tolerance: number): void => {
  console.log(`  ▸ ${label}: ${actual}, expected ${expected} within ${tolerance}`);
  expect(Math.abs(actual - expected), `${label}: ${actual}, expected ${expected}`).toBeLessThanOrEqual(tolerance);
};

const leftInSpot = async <T>(amount: number, check: () => Promise<T>): Promise<T> => {
  try {
    return await check();
  } catch (err) {
    console.error(`  ▸ ${amount} USDC may be left in Gate spot. Move it by hand before the next run.`);
    throw err;
  }
};

const sendLogged = async <T>(step: string, tag: string, dataDir: string, where: string, sendOnce: () => Promise<T>): Promise<T> => {
  try {
    return await sendOnce();
  } catch (err) {
    const { label, category, message, httpStatus } = classifyGateError(err);
    console.error(
      `  ▸ ${step} text=${tag} got ${label ?? category} HTTP ${httpStatus ?? 'none'}: ${message}. Job folder ${dataDir}. ${where}`,
    );
    throw err;
  }
};

const envAmount = (name: string, min: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`Set ${name} to the amount from the run order. Nothing was sent.`);
  }
  const amount = Number(raw);
  if (!(Number.isFinite(amount) && amount >= min && amount <= HARD_NOTIONAL_CEILING_USDT)) {
    throw new Error(`${name}=${raw} is not a number from ${min} to ${HARD_NOTIONAL_CEILING_USDT}. Nothing was sent.`);
  }
  return amount;
};

const spotUsdc = async (clients: Clients): Promise<number> => {
  const { body } = await clients.spot.listSpotAccounts({ currency: 'USDC' });
  const usdc = (body ?? []).find((r) => r.currency === 'USDC');
  console.log(`  ▸ Gate spot USDC available=${usdc?.available} locked=${usdc?.locked}`);
  return Number(usdc?.available ?? 0) + Number(usdc?.locked ?? 0);
};

const planRound = (round: number, move: Move, size: number, buy = 0): PlannedStep => ({
  round,
  kind: 'round',
  buy,
  move: size,
  arrives: arrivesFor(move.from, move.to, size),
  borrowLeft: 0,
  seconds: roundSeconds(move.from, move.to),
  ...move,
});

const planConvert = (size: number, arrives: number, move: Move): PlannedStep => ({
  round: null,
  kind: 'convert',
  buy: 0,
  move: size,
  arrives,
  borrowLeft: 0,
  seconds: 0,
  ...move,
});

const logJob = (job: Job, dataDir: string): void => {
  console.log(
    `  ▸ job ${job.id}: ${job.status}${job.haltReason ? ` (${job.haltReason})` : ''} fundsAt=${job.fundsAt} stepIndex=${job.stepIndex} file=${path.join(dataDir, 'rebalance.json')}`,
  );
  for (const step of job.steps) {
    console.log(
      `  ▸ round ${step.round} ${step.name}: status=${step.status} venueId=${step.venueId} qty=${step.qty} text=${step.text} quoteId=${step.quoteId} planned=${step.planned}`,
    );
  }
  const moving = inTransitOf(job);
  const where = moving ? `${moving.qty} ${moving.coin} ${moving.at === 'SPOT' ? 'in Gate spot' : 'on its way'}` : `at ${job.fundsAt}`;
  console.log(`  ▸ money of job ${job.id}: ${where}`);
};

const withCrossEx = (clients: Clients, overrides: Partial<CrossEx>): Clients => ({
  ...clients,
  crossEx: new Proxy(clients.crossEx, {
    get: (target, name, receiver) => Reflect.get(Object.hasOwn(overrides, name) ? overrides : target, name, receiver),
  }),
});

const recording = (clients: Clients, calls: Call[]): Clients => {
  const crossEx = clients.crossEx;
  const record = (call: Omit<Call, 'httpStatus' | 'label' | 'message'>): Call => {
    const entry: Call = { ...call, httpStatus: null, label: null, message: null };
    calls.push(entry);
    return entry;
  };
  const failed = (call: Call, err: unknown, what: string): void => {
    const { label, category, message, httpStatus } = classifyGateError(err);
    call.httpStatus = httpStatus ?? null;
    call.label = label ?? category;
    call.message = message;
    console.log(`  ▸ Gate answered ${what}: ${label ?? category} HTTP ${httpStatus ?? 'none'} ${message}`);
  };
  return withCrossEx(clients, {
    createCrossexTransfer: async (opts) => {
      const request = opts?.crossexTransferRequest;
      const call = record({ kind: 'transfer', key: request?.text ?? '', to: request?.to ?? '', amount: Number(request?.amount) });
      const what = `transfer ${request?.amount} ${request?.coin} ${request?.from} to ${request?.to} text=${call.key}`;
      try {
        const read = await crossEx.createCrossexTransfer(opts);
        console.log(`  ▸ Gate took ${what}: txId=${read.body.txId}`);
        return read;
      } catch (err) {
        const { label, category, message, httpStatus } = classifyGateError(err);
        call.httpStatus = httpStatus ?? null;
        call.label = label ?? category;
        call.message = message;
        console.log(`  ▸ Gate answered ${what}: ${label ?? category} HTTP ${httpStatus ?? 'none'} ${message}`);
        throw err;
      }
    },
    createCrossexOrder: async (opts) => {
      const request = opts?.crossexOrderRequest;
      record({ kind: 'order', key: request?.text ?? '', to: '', amount: Number(request?.qty ?? request?.quoteQty) });
      const read = await crossEx.createCrossexOrder(opts);
      console.log(
        `  ▸ Gate took ${request?.side} qty=${request?.qty} quoteQty=${request?.quoteQty} text=${request?.text}: orderId=${read.body.orderId}`,
      );
      return read;
    },
    createCrossexConvertQuote: async (opts) => {
      const request = opts?.crossexConvertQuoteRequest;
      const call = record({ kind: 'quote', key: request?.exchangeType ?? '', to: request?.toCoin ?? '', amount: Number(request?.fromAmount) });
      try {
        const read = await crossEx.createCrossexConvertQuote(opts);
        const { quoteId, fromAmount, toAmount } = read.body;
        call.id = String(quoteId);
        console.log(`  ▸ quote on ${request?.exchangeType}: quoteId=${quoteId} ${fromAmount} ${request?.fromCoin} to ${toAmount} ${request?.toCoin}`);
        return read;
      } catch (err) {
        failed(call, err, `quote ${request?.fromAmount} ${request?.fromCoin} on ${request?.exchangeType}`);
        throw err;
      }
    },
    createCrossexConvertOrder: async (opts) => {
      const quoteId = opts?.crossexConvertOrderRequest?.quoteId ?? '';
      const call = record({ kind: 'convert', key: quoteId, to: '', amount: 0 });
      try {
        const read = await crossEx.createCrossexConvertOrder(opts);
        console.log(`  ▸ Convert quoteId=${quoteId}: orderId=${read.body.orderId}`);
        return read;
      } catch (err) {
        failed(call, err, `Convert quoteId=${quoteId}`);
        throw err;
      }
    },
    listCrossexHistoryOrders: (opts) => {
      record({ kind: 'history', key: opts?.symbol ?? '', to: '', amount: 0 });
      return crossEx.listCrossexHistoryOrders(opts);
    },
  });
};

const callsOf = (calls: Call[], kind: CallKind): Call[] => calls.filter((call) => call.kind === kind);

const notFound404 = (): Error => Object.assign(new Error('ORDER_NOT_FOUND'), { response: { status: 404 } });

const gateTransferRows = async (clients: Clients, coin: TransferCoin, text: string): Promise<CrossexTransferRecord[]> => {
  const { body } = await clients.crossEx.listCrossexTransfers({ coin, limit: HISTORY_LIMIT });
  const tagged = (body ?? []).filter((r) => r.text === text);
  const listed = tagged.map((r) => `id=${r.id} status=${r.status} amount=${r.amount} actualReceive=${r.actualReceive}`).join(', ');
  console.log(`  ▸ Gate ${coin} transfer rows with text ${text}: ${listed || 'none'}`);
  return tagged;
};

const convertHistoryRow = async (
  clients: Clients,
  symbol: string,
  orderId: string,
  from: number,
): Promise<CrossexOrder | undefined> => {
  const { body } = await clients.crossEx.listCrossexHistoryOrders({ symbol, from, limit: HISTORY_LIMIT });
  const hit = (body ?? []).find((r) => String(r.orderId) === orderId);
  const found = hit ? `text=${hit.text} state=${hit.state} executedAmount=${hit.executedAmount}` : 'none';
  console.log(`  ▸ Gate ${symbol} history order ${orderId}: ${found}`);
  return hit;
};

const expectTransferOnGate = async (
  clients: Clients,
  coin: TransferCoin,
  text: string,
  venueId: string | null,
): Promise<CrossexTransferRecord> => {
  const rows = await gateTransferRows(clients, coin, text);
  expect(
    rows.map((r) => ({ id: String(r.id), status: r.status })),
    `Gate ${coin} rows with text ${text}`,
  ).toEqual([{ id: venueId, status: 'SUCCESS' }]);
  return rows[0];
};

const expectStepOnGate = async (clients: Clients, step: Step, symbol: string | undefined, from: number): Promise<void> => {
  const spec = STEPS[step.name as StepName];
  const venueId = String(step.venueId);
  if (spec.kind === 'transfer') {
    await expectTransferOnGate(clients, spec.coin, step.text ?? '', venueId);
    return;
  }
  if (spec.kind === 'convert') {
    if (!symbol) throw new Error(`${step.name} has no Convert symbol in the plan of this test`);
    const hit = await convertHistoryRow(clients, symbol, venueId, from);
    expect({ orderId: hit && String(hit.orderId), text: hit?.text }, `${step.name} in ${symbol}`).toEqual({
      orderId: venueId,
      text: step.quoteId,
    });
    return;
  }
  const { body } = await clients.crossEx.getCrossexOrder(venueId);
  console.log(
    `  ▸ Gate order ${venueId}: text=${body.text} state=${body.state} executedQty=${body.executedQty} executedAmount=${body.executedAmount}`,
  );
  expect(body.text, `${step.name} order ${venueId}`).toBe(step.text);
};

const expectJob = async (clients: Clients, job: Job, planned: Planned[]): Promise<Step[]> => {
  const names = job.steps.map((step) => step.name).join(', ');
  expect(job.status, `${job.haltReason ?? ''} steps: ${names}`).toBe('done');
  const matched = new Map<Step, Planned>();
  for (const step of job.steps) {
    const want = planned[matched.size];
    if (want && step.name === want.name) {
      matched.set(step, want);
      continue;
    }
    expect(step.name, `extra step in ${names}`).toBe('Sell USDC');
    expect(step.status, `extra Sell USDC in ${names}`).toBe('done');
  }
  expect(
    [...matched.keys()].map((step) => step.name),
    names,
  ).toEqual(planned.map((want) => want.name));
  const from = job.createdAt - SWEEP_SKEW_MS;
  for (const step of job.steps) {
    const want = matched.get(step);
    if (want) {
      expect(step.status, step.name).toBe('done');
      expect(step.venueId, `${step.name} venueId`).not.toBeNull();
      expect({ from: step.from, to: step.to, round: step.round }, step.name).toEqual({
        from: want.from,
        to: want.to,
        round: want.round,
      });
    }
    if (step.venueId !== null) await expectStepOnGate(clients, step, want?.symbol, from);
  }
  return [...matched.keys()];
};

const runLogged = async (jobs: JobFile, job: Job, clients: Clients, dataDir: string): Promise<void> => {
  try {
    await runJob({
      clients: () => clients,
      jobs,
      cache: new TtlCache(),
      now: Date.now,
      sleep,
      onHalt: (halted) => console.error(`  ▸ halted: ${halted.haltReason}`),
    });
  } finally {
    logJob(job, dataDir);
  }
};

const runLiveJob = async (clients: Clients, input: JobInput): Promise<Ran> => {
  const dataDir = newDir('rebalance-lighter-');
  const jobs = new JobFile(dataDir);
  const job = newJob({ ...input, target: [], userId: null }, Date.now());
  const before = await readAssets(clients);
  logBalances('before the job', before);
  jobs.write(job);
  console.log(`  ▸ job ${job.id} written to ${dataDir}`);
  await runLogged(jobs, job, clients, dataDir);
  const after = await readAssets(clients);
  logBalances('after the job', after);
  return { job, before, after };
};

const RATE_LIMIT_RESUMES = 3;
const RATE_LIMIT_WAIT_MS = 60_000;

const runConvertParts = async (clients: Clients, move: Move, parts: number[]): Promise<Ran> => {
  const dataDir = newDir('rebalance-lighter-');
  const jobs = new JobFile(dataDir);
  const amount = nearestCents(parts.reduce((total, part) => total + part, 0));
  const arrives = floorCents(amount * (1 - CONVERT_RATE) ** 2);
  const input = { route: 'convert' as const, steps: [planConvert(amount, arrives, move)], amount, costUsd: nearestCents(amount - arrives) };
  const job = newJob({ ...input, target: [], userId: null }, Date.now());
  job.steps = parts.flatMap((part) => convertSteps(move.from, move.to, part));
  const before = await readAssets(clients);
  logBalances('before the job', before);
  jobs.write(job);
  console.log(`  ▸ job ${job.id} with ${job.steps.length} Convert steps written to ${dataDir}`);
  await runLogged(jobs, job, clients, dataDir);
  for (let pass = 1; pass <= RATE_LIMIT_RESUMES && job.haltReason === HALT_TEXT.rateLimited; pass += 1) {
    console.log(`  ▸ rate-limited: Resume ${pass} of ${RATE_LIMIT_RESUMES} after ${RATE_LIMIT_WAIT_MS / 1000} s`);
    await sleep(RATE_LIMIT_WAIT_MS);
    Object.assign(job, { status: 'running', haltReason: null });
    job.steps[job.stepIndex].startedAt = Date.now();
    jobs.write(job);
    await runLogged(jobs, job, clients, dataDir);
  }
  const after = await readAssets(clients);
  logBalances('after the job', after);
  return { job, before, after };
};

const walletName = (wallet: { coin: string; venue: string }): string => `${wallet.coin}/${wallet.venue}`;

const convertInParts = async (move: Move, part: number, symbols: string[]): Promise<void> => {
  const clients = assertCredentials();
  const before = await readAssets(clients);
  const fromWallet = move.from === 'CROSSEX' ? USDT_WALLET : poolWallet(move.from);
  const cash = balanceOf(before, fromWallet);
  if (!(cash >= 2 * part)) {
    throw new Error(`${walletName(fromWallet)} cash ${cash} is under ${2 * part}. Nothing was sent.`);
  }
  if (!(balanceOf(before, USDT_WALLET) >= 0)) {
    throw new Error('USDT/CROSSEX cash is under 0. Nothing was sent.');
  }
  if (!(balanceOf(before, GATE_WALLET) < DUST_USDC)) {
    throw new Error(`USDC/GATE cash is not under ${DUST_USDC}. The job would add a Sell USDC step. Nothing was sent.`);
  }

  budget.beforeOrder(2 * part, `Convert ${move.from} to ${move.to} in two parts`);

  const calls: Call[] = [];
  const { job, before: start, after } = await runConvertParts(recording(clients, calls), move, [part, part]);
  const twoHalves = symbols.length === 2;
  const planned: Planned[] = twoHalves
    ? [0, 1].flatMap(() => [
        { name: 'Convert to USDT' as const, ...move, round: null, symbol: symbols[0] },
        { name: 'Convert to USDC' as const, ...move, round: null, symbol: symbols[1] },
      ])
    : [0, 1].map(() => ({ name: 'Convert' as const, ...move, round: null, symbol: symbols[0] }));
  const steps = await expectJob(clients, job, planned);
  const quotes = callsOf(calls, 'quote');
  const orders = callsOf(calls, 'convert');
  const refused = [...quotes, ...orders].filter((call) => call.httpStatus !== null);
  const taken = orders.filter((call) => call.httpStatus === null);
  for (const call of refused) {
    expect(`${call.httpStatus} ${call.label}`, `only a rate limit may refuse a ${call.kind}`).toMatch(/^429 |TOO_MANY|RATE_LIMIT|rate-limited/);
  }
  expect(taken, 'one accepted Convert order per step').toHaveLength(steps.length);
  expect(orders.length, 'each accepted quote gets one order call').toBe(quotes.length - refused.filter((call) => call.kind === 'quote').length);
  expect(new Set(taken.map((call) => call.key)).size, 'no quote id sent twice').toBe(taken.length);
  expect(taken.map((call) => call.key), 'the steps hold the accepted quote ids').toEqual(steps.map((step) => step.quoteId));
  const from = job.createdAt - SWEEP_SKEW_MS;
  for (const call of orders.filter((order) => order.httpStatus !== null)) {
    expect(taken.map((order) => order.key), `refused quote id ${call.key} was not sent again`).not.toContain(call.key);
    for (const symbol of new Set(symbols)) {
      const { body } = await clients.crossEx.listCrossexHistoryOrders({ symbol, from, limit: HISTORY_LIMIT });
      const rows = (body ?? []).filter((row) => row.text === call.key);
      console.log(`  ▸ Gate ${symbol} rows with the refused quote id ${call.key}: ${rows.length}`);
      expect(rows, `no ${symbol} order for the refused quote id ${call.key}`).toHaveLength(0);
    }
  }
  for (const quote of quotes) expect(quote.amount, 'each quote is at most one part').toBeLessThanOrEqual(part);
  if (twoHalves) {
    steps.forEach((step, index) => {
      if (step.name !== 'Convert to USDC') return;
      const sent = quotes.find((quote) => quote.id === step.quoteId)?.amount;
      const given = floorCents(qtyOf(steps[index - 1]));
      expect(sent, `Convert to USDC ${index} sends what its own Convert to USDT returned`).toBeLessThanOrEqual(given);
      expect(sent).toBeGreaterThanOrEqual(given - FEE_TOLERANCE);
    });
  }
  expect(job.fundsAt).toBe(move.to);
  const landed = steps.filter((step) => step.name !== 'Convert to USDT').reduce((total, step) => total + qtyOf(step), 0);
  const toWallet = move.to === 'CROSSEX' ? USDT_WALLET : poolWallet(move.to);
  expectNear(`${walletName(fromWallet)} change`, changeOf(start, after, fromWallet), -2 * part, MOVE_TOLERANCE);
  expectNear(`${walletName(toWallet)} change`, changeOf(start, after, toWallet), landed, MOVE_TOLERANCE);
  if (twoHalves) expectNear('USDT/CROSSEX change', changeOf(start, after, USDT_WALLET), 0, MOVE_TOLERANCE);
};

const writeRunningJob = (input: JobInput & { userId: string | null }) => {
  const dataDir = newDir('rebalance-lighter-');
  const jobs = new JobFile(dataDir);
  const job = newJob({ ...input, target: [] }, Date.now());
  const [step] = job.steps;
  job.tagCount = 1;
  step.status = 'running';
  step.startedAt = Date.now();
  step.text = tagFor(job.id, job.tagCount);
  jobs.write(job);
  console.log(`  ▸ job ${job.id} step ${step.name} text=${step.text} written to ${dataDir}`);
  return { dataDir, jobs, job, step };
};

const waitStatus = async (jobs: JobFile, statuses: readonly JobStatus[], ms: number): Promise<Job> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const job = jobs.read();
    if (job && statuses.includes(job.status)) return job;
    if (Date.now() > deadline) {
      throw new Error(`rebalance job is ${job?.status} after ${ms / 1000} s, not ${statuses.join(' or ')}`);
    }
    await sleep(POLL_MS);
  }
};

const waitBought = async (clients: Clients, orderId: string): Promise<number> => {
  const deadline = Date.now() + SETUP_WAIT_MS;
  for (;;) {
    const order = await clients.crossEx.getCrossexOrder(orderId).then(
      ({ body }) => body,
      (err: unknown) => {
        console.log(`  ▸ Buy USDC ${orderId}: ${classifyGateError(err).message}`);
        return null;
      },
    );
    if (order) {
      console.log(
        `  ▸ Buy USDC ${orderId}: state=${order.state} executedQty=${order.executedQty} fee=${order.fee} feeCoin=${order.feeCoin}`,
      );
    }
    if (order && decodeStatus(String(order.state ?? '')) === 'closed') {
      const fee = String(order.feeCoin ?? '') === 'USDC' ? Number(order.fee ?? 0) : 0;
      return Number(order.executedQty ?? 0) - fee;
    }
    if (Date.now() > deadline) {
      throw new Error(`Buy USDC ${orderId} is not filled after ${SETUP_WAIT_MS / 1000} s. Check USDT · CrossEx and USDC · Gate.`);
    }
    await sleep(POLL_MS);
  }
};

const buyGateUsdc = async (clients: Clients): Promise<void> => {
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
  let gateCash = balanceOf(await readAssets(clients), GATE_WALLET);
  while (gateCash < DUST_USDC) {
    if (Date.now() > deadline) {
      throw new Error(`USDC/GATE cash ${gateCash} is still under ${DUST_USDC} ${SETUP_WAIT_MS / 1000} s after the setup buy.`);
    }
    await sleep(POLL_MS);
    gateCash = balanceOf(await readAssets(clients), GATE_WALLET);
  }
  console.log(`  ▸ USDC/GATE cash ${gateCash} before the Convert job`);
};

const refusedSetup = (err: unknown): Error => {
  const { label, category, message } = classifyGateError(err);
  return new Error(`Gate refused the setup Convert. No borrow was made. ${label ?? category}: ${message}`);
};

const convertFill = async (clients: Clients, key: string): Promise<number | null> => {
  const deadline = Date.now() + SETUP_WAIT_MS;
  for (;;) {
    const order = await clients.crossEx.getCrossexOrder(key).then(
      ({ body }) => body,
      (err: unknown) => {
        console.log(`  ▸ setup Convert ${key}: ${classifyGateError(err).message}`);
        return null;
      },
    );
    if (order) {
      console.log(
        `  ▸ setup Convert ${key}: orderId=${order.orderId} text=${order.text} state=${order.state} executedAmount=${order.executedAmount}`,
      );
    }
    if (order && decodeStatus(String(order.state ?? '')) === 'closed') return Number(order.executedAmount ?? 0);
    if (Date.now() > deadline) {
      if (!order) return null;
      throw new Error(
        `Setup Convert ${order.orderId} is ${order.state} after ${SETUP_WAIT_MS / 1000} s. A borrow may exist. Read USDC · Lighter and repay it with a Convert into Lighter.`,
      );
    }
    await sleep(POLL_MS);
  }
};

const convertOutOfLighter = async (clients: Clients, setup: number): Promise<number> => {
  const { body: quote } = await clients.crossEx
    .createCrossexConvertQuote({
      crossexConvertQuoteRequest: { exchangeType: 'LIGHTER', fromCoin: 'USDC', toCoin: 'USDT', fromAmount: String(setup) },
    })
    .catch((err: unknown): never => {
      throw refusedSetup(err);
    });
  console.log(`  ▸ setup quote quoteId=${quote.quoteId} ${quote.fromAmount} USDC to ${quote.toAmount} USDT validMs=${quote.validMs}`);
  const toAmount = Number(quote.toAmount);
  if (!(toAmount >= quoteFloor(setup, 'USDT', await readSpotTicker(clients).catch(() => null)))) {
    throw new Error(`Setup quote ${quote.toAmount} USDT for ${setup} USDC is under the quote floor. Nothing was sent.`);
  }
  const room = RUN_BUDGET_NOTIONALS * NOTIONAL - budget.openedNotional;
  if (!(toAmount <= HARD_NOTIONAL_CEILING_USDT && toAmount <= room)) {
    throw new Error(`The repay of ${toAmount} USDT does not fit the run budget (${room} left). Set LIVE_TRADE_NOTIONAL=40. Nothing was sent.`);
  }
  const quoteId = String(quote.quoteId);
  let key = quoteId;
  try {
    const { body } = await clients.crossEx.createCrossexConvertOrder({ crossexConvertOrderRequest: { quoteId } });
    console.log(`  ▸ setup Convert orderId=${body.orderId} text=${body.text}`);
    key = String(body.orderId);
  } catch (err) {
    const { httpStatus, message } = classifyGateError(err);
    if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) throw refusedSetup(err);
    console.error(`  ▸ Gate did not answer the setup Convert (quote ${quoteId}): ${message}. Looking it up by the quote id.`);
  }
  const filled = await convertFill(clients, key);
  if (filled === null) {
    const cash = await readAssets(clients).then(
      (list) => String(balanceOf(list, LIGHTER_WALLET)),
      (err: unknown) => `unread (${classifyGateError(err).message})`,
    );
    console.error(`  ▸ setup: Gate shows no filled order for ${key}, quote ${quoteId}. USDC/LIGHTER cash=${cash}.`);
    throw new Error(
      `No fill found for the setup Convert (quote ${quoteId}). A borrow may exist. Read USDC · Lighter and repay it with a Convert into Lighter.`,
    );
  }
  if (!(filled > 0)) {
    throw new Error(`Setup Convert ${key} closed with nothing filled (quote ${quoteId}). No borrow was made.`);
  }
  if (Math.abs(filled - toAmount) > FILL_TOLERANCE) {
    console.log(`  ▸ setup fill ${filled} USDT differs from the quote ${toAmount} USDT. The repay uses the fill.`);
  }
  return filled;
};

const waitLighter = async (
  clients: Clients,
  label: string,
  reached: (asset: CrossexAccountAsset | undefined) => boolean,
): Promise<CrossexAccountAsset[]> => {
  const deadline = Date.now() + SETUP_WAIT_MS;
  for (;;) {
    const assets = await readAssets(clients);
    logWallet(label, assets, LIGHTER_WALLET);
    if (reached(row(assets, LIGHTER_WALLET)) || Date.now() > deadline) return assets;
    await sleep(POLL_MS);
  }
};

const bootApp = async (clients: Clients, rebalanceDir: string) => {
  const transferDir = newDir('transfer-lighter-');
  const jobs = new JobFile(rebalanceDir);
  const transfers = new TransferFile(transferDir);
  const app = buildApp({
    getClients: () => clients,
    cache: new TtlCache(),
    dataDir: rebalanceDir,
    authToken: TOKEN,
    engine: { store: new Store(':memory:'), venue: gateVenue(() => clients), clock: { now: Date.now } },
    rebalance: { jobs, sleep },
    transfer: { jobs: transfers, sleep },
  });
  await app.ready();
  console.log(`  ▸ app booted on ${rebalanceDir} and ${transferDir}`);

  const post: Post = async ({ coin, from, to, amount }) => {
    const before = await readAssets(clients);
    const res = await app.inject({
      method: 'POST',
      url: '/api/transfer',
      headers: HEADERS,
      payload: { coin, from, to, amount: String(amount) },
    });
    console.log(`  ▸ POST ${amount} ${coin} ${from} to ${to}: HTTP ${res.statusCode} ${res.body}`);
    if (res.statusCode !== 202) return { statusCode: res.statusCode, body: res.body, transfer: null };
    const waitMs = SLOW_WALLETS.includes(from) || SLOW_WALLETS.includes(to) ? SLOW_WAIT_MS : QUICK_WAIT_MS;
    const deadline = Date.now() + waitMs;
    while (transfers.read()?.status === 'moving') {
      if (Date.now() > deadline) {
        throw new Error(`${amount} ${coin} ${from} to ${to} is still moving after ${waitMs / 1000} s. transfer.json is in ${transferDir}.`);
      }
      await sleep(POLL_MS);
    }
    const transfer = transfers.read();
    if (!transfer) throw new Error(`transfer.json in ${transferDir} is unreadable`);
    console.log(
      `  ▸ ${coin} ${from} to ${to}: ${transfer.status} text=${transfer.text} venueId=${transfer.venueId} amount=${amount} received=${transfer.received} failText=${transfer.failText}`,
    );
    logBalances('before the transfer', before);
    logBalances('after the transfer', await readAssets(clients));
    return { statusCode: res.statusCode, body: res.body, transfer: { ...transfer } };
  };

  const send = async (leg: TransferLeg): Promise<TransferJob> => {
    const { statusCode, body, transfer } = await post(leg);
    expect(statusCode, body).toBe(202);
    if (!transfer) throw new Error(`POST ${leg.coin} ${leg.from} to ${leg.to} gave no transfer`);
    if (transfer.status !== 'done') console.log(`  ▸ ${leg.amount} ${leg.coin} did not move. It stays in ${leg.from}.`);
    expect(transfer.status, transfer.failText ?? '').toBe('done');
    const check = () => expectTransferOnGate(clients, leg.coin, transfer.text, transfer.venueId);
    await (leg.to === 'SPOT' ? leftInSpot(transfer.received ?? leg.amount, check) : check());
    return transfer;
  };

  const getInTransit = async (): Promise<unknown> => {
    const res = await app.inject({ method: 'GET', url: '/api/rebalance', headers: HEADERS });
    const inTransit = res.statusCode === 200 ? res.json().data.job?.inTransit : undefined;
    console.log(`  ▸ GET /api/rebalance: HTTP ${res.statusCode} inTransit=${JSON.stringify(inTransit)}`);
    expect(res.statusCode, res.body).toBe(200);
    return inTransit;
  };

  const postJob = async (action: 'resume' | 'abandon', id: string): Promise<Job> => {
    const res = await app.inject({ method: 'POST', url: `/api/rebalance/${id}/${action}`, headers: HEADERS, payload: {} });
    console.log(`  ▸ POST ${action} ${id}: HTTP ${res.statusCode}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as Job;
  };

  return { app, jobs, post, send, getInTransit, postJob };
};

const minimumLeg = async (clients: Clients, post: Post, calls: Call[], leg: TransferLeg): Promise<LegOutcome> => {
  const what = `${leg.amount} ${leg.coin} ${leg.from} to ${leg.to}`;
  const before = await readAssets(clients);
  const spotBefore = await spotUsdc(clients);
  const sentBefore = calls.length;
  const { statusCode, body, transfer } = await post(leg);
  if (!transfer) {
    throw new Error(
      `The app refused ${what} before any send: HTTP ${statusCode} ${body}. If it names a minimum, the code minimum is not ${leg.amount}.`,
    );
  }
  if (transfer.status === 'done') {
    const check = () => expectTransferOnGate(clients, leg.coin, transfer.text, transfer.venueId);
    const gateRow = await (leg.to === 'SPOT' ? leftInSpot(transfer.received ?? leg.amount, check) : check());
    console.log(`  ▸ outcome: Gate took ${what}. received=${transfer.received}`);
    return { outcome: 'done', transfer, row: gateRow };
  }
  const refusal = calls
    .slice(sentBefore)
    .find((call) => call.kind === 'transfer' && call.httpStatus !== null && call.httpStatus >= 400 && call.httpStatus < 500);
  if (!refusal) {
    throw new Error(`${what} ended ${transfer.status} (${transfer.failText}) with no 4xx from Gate. Check where the USDC is.`);
  }
  const answer = `${refusal.label} HTTP ${refusal.httpStatus}: ${refusal.message}`;
  if (!MINIMUM_REFUSAL.test(`${refusal.label} ${refusal.message}`)) {
    throw new Error(`Gate refused ${what} with ${answer}. That is not a minimum refusal. failText=${transfer.failText}`);
  }
  console.log(`  ▸ outcome: Gate refused ${what} for its minimum with ${answer}. failText=${transfer.failText}`);
  const after = await readAssets(clients);
  logBalances('after the refusal', after);
  expectNear('USDC/LIGHTER change after the refusal', changeOf(before, after, LIGHTER_WALLET), 0, MOVE_TOLERANCE);
  expectNear('Gate spot USDC change after the refusal', (await spotUsdc(clients)) - spotBefore, 0, MOVE_TOLERANCE);
  return { outcome: 'refused' };
};

const convertBetweenVenues = async (amount: number, move: { from: Venue; to: Venue }, symbols: [string, string]) => {
  assertLiveTestsEnabled();
  assertAck();
  assertNotionalCeiling();
  const clients = assertCredentials();

  const before = await readAssets(clients);
  logBalances('before', before);
  const fromWallet = poolWallet(move.from);
  const cash = balanceOf(before, fromWallet);
  if (!(cash >= amount)) {
    throw new Error(`USDC/${move.from} cash ${cash} is under ${amount}. Nothing was sent.`);
  }
  const usdt = balanceOf(before, USDT_WALLET);
  if (!(usdt >= 0)) {
    throw new Error(`USDT/CROSSEX cash ${usdt} is under 0. The job would stop before the first half. Nothing was sent.`);
  }

  budget.beforeOrder(amount, `Convert ${move.from} to ${move.to} in two halves`);

  const calls: Call[] = [];
  const arrives = floorCents(amount * (1 - CONVERT_RATE) ** 2);
  const { job, before: start, after } = await runLiveJob(recording(clients, calls), {
    route: 'convert',
    steps: [planConvert(amount, arrives, move)],
    amount,
    costUsd: nearestCents(amount - arrives),
  });

  const [first, second] = await expectJob(clients, job, [
    { name: 'Convert to USDT', ...move, round: null, symbol: symbols[0] },
    { name: 'Convert to USDC', ...move, round: null, symbol: symbols[1] },
  ]);
  const quotes = callsOf(calls, 'quote');
  expect(quotes.map((call) => call.key)).toEqual([move.from, move.to]);
  expect(quotes[1]?.amount).toBeLessThanOrEqual(floorCents(qtyOf(first)));
  expect(job.fundsAt).toBe(move.to);
  expectNear('USDT/CROSSEX change', changeOf(start, after, USDT_WALLET), 0, MOVE_TOLERANCE);
  expectNear(`USDC/${move.from} change`, changeOf(start, after, fromWallet), -amount, MOVE_TOLERANCE);
  expectNear(`USDC/${move.to} change`, changeOf(start, after, poolWallet(move.to)), qtyOf(second), MOVE_TOLERANCE);
};

describe.skipIf(process.env.REBALANCE_LIGHTER !== '1')('live rebalance Lighter paths and recovery', () => {
  it('manual USDC round trip between the Lighter wallet and Gate spot', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const spare = spareOf(before, LIGHTER_WALLET);
    if (!(spare >= USDC_ROUND_TRIP)) {
      throw new Error(`USDC/LIGHTER spare cap ${spare} is below ${USDC_ROUND_TRIP} USDC. Nothing was sent.`);
    }

    budget.beforeOrder(USDC_ROUND_TRIP, 'Lighter USDC round trip');

    const { app, send } = await bootApp(clients, newDir('rebalance-lighter-'));
    try {
      const out = await send({ coin: 'USDC', from: 'CROSSEX_LIGHTER', to: 'SPOT', amount: USDC_ROUND_TRIP });
      const back = await leftInSpot(out.received ?? USDC_ROUND_TRIP, async () => {
        expect(out.received).toBe(USDC_ROUND_TRIP);
        return send({ coin: 'USDC', from: 'SPOT', to: 'CROSSEX_LIGHTER', amount: floorCents(out.received ?? 0) });
      });
      const after = await readAssets(clients);
      logBalances('after', after);
      expectNear('Lighter deposit fee', USDC_ROUND_TRIP - (back.received ?? 0), LIGHTER_DEPOSIT_FEE_USD, FEE_TOLERANCE);
      expectNear(
        'USDC/LIGHTER change',
        changeOf(before, after, LIGHTER_WALLET),
        (back.received ?? 0) - USDC_ROUND_TRIP,
        MOVE_TOLERANCE,
      );
    } finally {
      await app.close();
    }
  }, 1_900_000);

  it('manual USDC transfer of exactly 11.00 each way between the Lighter wallet and Gate spot', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const spare = spareOf(before, LIGHTER_WALLET);
    if (!(spare >= EXACT_MINIMUM_USDC)) {
      throw new Error(`USDC/LIGHTER spare cap ${spare} is below ${EXACT_MINIMUM_USDC} USDC. Nothing was sent.`);
    }
    const spotBefore = await spotUsdc(clients);
    if (!(spotBefore < DUST_USDC)) {
      throw new Error(`Gate spot USDC ${spotBefore} is not under ${DUST_USDC}. Nothing was sent.`);
    }

    budget.beforeOrder(EXACT_MINIMUM_USDC, 'Lighter USDC at exactly 11.00');

    const calls: Call[] = [];
    const { app, post } = await bootApp(recording(clients, calls), newDir('rebalance-lighter-'));
    try {
      const out = await minimumLeg(clients, post, calls, {
        coin: 'USDC',
        from: 'CROSSEX_LIGHTER',
        to: 'SPOT',
        amount: EXACT_MINIMUM_USDC,
      });
      if (out.outcome === 'refused') {
        console.log('  ▸ pass on refusal: Gate refused 11.00 USDC out of USDC · Lighter. Nothing moved. Leg 2 was not sent.');
        return;
      }
      const back = await leftInSpot(out.transfer.received ?? EXACT_MINIMUM_USDC, async () => {
        expect(out.transfer.received, 'received in Gate spot').toBe(EXACT_MINIMUM_USDC);
        return minimumLeg(clients, post, calls, {
          coin: 'USDC',
          from: 'SPOT',
          to: 'CROSSEX_LIGHTER',
          amount: EXACT_MINIMUM_USDC,
        });
      });
      if (back.outcome === 'refused') {
        throw new Error(
          `Gate refused ${EXACT_MINIMUM_USDC} USDC from Gate spot into USDC · Lighter. ${EXACT_MINIMUM_USDC} USDC is left in Gate spot. Move it by hand.`,
        );
      }

      const { transfer, row: gateRow } = back;
      const actual = Number(gateRow.actualReceive);
      const reported = actual > 0 ? Number(gateRow.amount) - actual : null;
      console.log(
        `  ▸ fee Gate reports on the way in: ${reported ?? 'none, no actualReceive'}. The app uses ${LIGHTER_DEPOSIT_FEE_USD}, so it expects ${nearestCents(EXACT_MINIMUM_USDC - LIGHTER_DEPOSIT_FEE_USD)}.`,
      );
      expectNear(
        'received in USDC · Lighter',
        transfer.received ?? 0,
        EXACT_MINIMUM_USDC - (reported ?? LIGHTER_DEPOSIT_FEE_USD),
        FEE_TOLERANCE,
      );
      const after = await readAssets(clients);
      logBalances('after', after);
      expectNear(
        'USDC/LIGHTER change',
        changeOf(before, after, LIGHTER_WALLET),
        (transfer.received ?? 0) - EXACT_MINIMUM_USDC,
        MOVE_TOLERANCE,
      );
      expectNear('Gate spot USDC change', (await spotUsdc(clients)) - spotBefore, 0, MOVE_TOLERANCE);
    } finally {
      await app.close();
    }
  }, 1_900_000);

  it('Spot loop then Convert into Lighter: Buy USDC, To spot, To Lighter, Convert', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const cash = balanceOf(before, USDT_WALLET);
    if (!(cash > 2 * ROUND)) {
      throw new Error(`USDT/CROSSEX balance ${cash} is not above ${2 * ROUND}. Nothing was sent.`);
    }
    const gateCash = balanceOf(before, GATE_WALLET);
    if (!(gateCash < DUST_USDC)) {
      throw new Error(`USDC/GATE cash ${gateCash} is not under ${DUST_USDC}. The job would add a Sell USDC step. Nothing was sent.`);
    }

    budget.beforeOrder(2 * ROUND, 'Spot loop then Convert into Lighter');

    const move: Move = { from: 'CROSSEX', to: 'LIGHTER' };
    const { job, before: start, after } = await runLiveJob(clients, {
      route: 'mix',
      steps: [planRound(1, move, ROUND, ROUND), planConvert(ROUND, CONVERT_ARRIVES, move)],
      amount: 2 * ROUND,
      costUsd: MIX_COST_USD,
    });

    const [, toSpot, intoLighter, convert] = await expectJob(clients, job, [
      { name: 'Buy USDC', ...move, round: 1 },
      { name: 'To spot', ...move, round: 1 },
      { name: 'To Lighter', ...move, round: 1 },
      { name: 'Convert', ...move, round: null, symbol: 'LIGHTER_CONVERT_USDT_USDC' },
    ]);
    expect(job.fundsAt).toBe('LIGHTER');
    expectNear('Lighter deposit fee', qtyOf(toSpot) - qtyOf(intoLighter), LIGHTER_DEPOSIT_FEE_USD, FEE_TOLERANCE);
    expectNear('USDC/LIGHTER change', changeOf(start, after, LIGHTER_WALLET), qtyOf(intoLighter) + qtyOf(convert), MOVE_TOLERANCE);
    expectNear('USDT/CROSSEX change', changeOf(start, after, USDT_WALLET), -2 * ROUND, CASH_TOLERANCE);
  }, 1_900_000);

  it('one job, two moves out of Lighter: a round to Hyperliquid, then a round to CrossEx', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const spare = spareOf(before, LIGHTER_WALLET);
    if (!(spare >= 2 * ROUND)) {
      throw new Error(`USDC/LIGHTER spare cap ${spare} is below ${2 * ROUND} USDC. Nothing was sent.`);
    }
    const gateCash = balanceOf(before, GATE_WALLET);
    if (!(gateCash < DUST_USDC)) {
      throw new Error(`USDC/GATE cash ${gateCash} is not under ${DUST_USDC}. The job would sell it too. Nothing was sent.`);
    }

    budget.beforeOrder(2 * ROUND, 'two moves out of Lighter');

    const toHyperliquid: Move = { from: 'LIGHTER', to: 'HYPERLIQUID' };
    const toCrossEx: Move = { from: 'LIGHTER', to: 'CROSSEX' };
    const calls: Call[] = [];
    const { job, before: start, after } = await runLiveJob(recording(clients, calls), {
      route: 'loop',
      steps: [planRound(1, toHyperliquid, ROUND), planRound(2, toCrossEx, ROUND)],
      amount: 2 * ROUND,
      costUsd: HYPERLIQUID_DEPOSIT_FEE_USD,
    });

    const [, intoHyperliquid] = await expectJob(clients, job, [
      { name: 'From Lighter', ...toHyperliquid, round: 1 },
      { name: 'To Hyperliquid', ...toHyperliquid, round: 1 },
      { name: 'From Lighter', ...toCrossEx, round: 2 },
      { name: 'To Gate', ...toCrossEx, round: 2 },
      { name: 'Sell USDC', ...toCrossEx, round: 2 },
    ]);
    const orders = callsOf(calls, 'order').map((call) => ({
      text: call.key,
      round: job.steps.find((step) => step.text === call.key)?.round ?? null,
    }));
    console.log(`  ▸ spot orders by round: ${JSON.stringify(orders)}`);
    expect(orders.filter((order) => order.round === 1), 'spot orders in round 1').toHaveLength(0);
    expect(job.fundsAt).toBe('CROSSEX');
    expectNear('Hyperliquid deposit fee', ROUND - qtyOf(intoHyperliquid), HYPERLIQUID_DEPOSIT_FEE_USD, FEE_TOLERANCE);
    expectNear('USDC/HYPERLIQUID change', changeOf(start, after, USDC_WALLET), qtyOf(intoHyperliquid), MOVE_TOLERANCE);
    expectNear('USDT/CROSSEX change', changeOf(start, after, USDT_WALLET), soldOf(job), MOVE_TOLERANCE);
    expectNear('USDC/LIGHTER change', changeOf(start, after, LIGHTER_WALLET), -2 * ROUND, MOVE_TOLERANCE);
  }, 1_900_000);

  it('Spot loop from Hyperliquid to Lighter: From Hyperliquid, To Lighter, no spot order', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const spare = spareOf(before, USDC_WALLET);
    if (!(spare >= HL_TO_LIGHTER_ROUND)) {
      throw new Error(`USDC/HYPERLIQUID spare cap ${spare} is below ${HL_TO_LIGHTER_ROUND} USDC. Nothing was sent.`);
    }

    budget.beforeOrder(HL_TO_LIGHTER_ROUND, 'Spot loop from Hyperliquid to Lighter');

    const move: Move = { from: 'HYPERLIQUID', to: 'LIGHTER' };
    const calls: Call[] = [];
    const { job, before: start, after } = await runLiveJob(recording(clients, calls), {
      route: 'loop',
      steps: [planRound(1, move, HL_TO_LIGHTER_ROUND)],
      amount: HL_TO_LIGHTER_ROUND,
      costUsd: nearestCents(HYPERLIQUID_WITHDRAW_FEE_USD + LIGHTER_DEPOSIT_FEE_USD),
    });

    const [fromHyperliquid, intoLighter] = await expectJob(clients, job, [
      { name: 'From Hyperliquid', ...move, round: 1 },
      { name: 'To Lighter', ...move, round: 1 },
    ]);
    expect(callsOf(calls, 'order'), 'spot orders').toHaveLength(0);
    expect(callsOf(calls, 'convert'), 'Convert orders').toHaveLength(0);
    expectNear(
      'From Hyperliquid qty',
      qtyOf(fromHyperliquid),
      HL_TO_LIGHTER_ROUND - HYPERLIQUID_WITHDRAW_FEE_USD,
      FEE_TOLERANCE,
    );
    expect(intoLighter.planned).toBe(spotArrivalFor('HYPERLIQUID', HL_TO_LIGHTER_ROUND));
    expectNear('To Lighter qty', qtyOf(intoLighter), arrivesFor('HYPERLIQUID', 'LIGHTER', HL_TO_LIGHTER_ROUND), FEE_TOLERANCE);
    expectNear('USDC/HYPERLIQUID change', changeOf(start, after, USDC_WALLET), -HL_TO_LIGHTER_ROUND, MOVE_TOLERANCE);
    expectNear('USDC/LIGHTER change', changeOf(start, after, LIGHTER_WALLET), qtyOf(intoLighter), MOVE_TOLERANCE);
  }, 3_700_000);

  it('Convert toward Lighter sells the Gate wallet USDC first', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const gateCash = balanceOf(before, GATE_WALLET);
    const needsBuy = gateCash < DUST_USDC;
    if (!needsBuy && gateCash < SPOT_MIN_QUOTE_USDT) {
      throw new Error(
        `USDC/GATE cash ${gateCash} is from ${DUST_USDC} to ${SPOT_MIN_QUOTE_USDT}. The job would not sell it. Nothing was sent.`,
      );
    }
    if (gateCash > GATE_CASH_MAX) {
      throw new Error(`USDC/GATE cash ${gateCash} is above ${GATE_CASH_MAX}. The job would sell all of it. Nothing was sent.`);
    }
    const cash = balanceOf(before, USDT_WALLET);
    if (!(cash > SETUP_BUY_USDT + ROUND)) {
      throw new Error(`USDT/CROSSEX balance ${cash} is not above ${SETUP_BUY_USDT + ROUND}. Nothing was sent.`);
    }

    budget.beforeOrder((needsBuy ? SETUP_BUY_USDT : floorCents(gateCash)) + ROUND, 'Convert toward Lighter after a Gate wallet sale');

    if (needsBuy) await buyGateUsdc(clients);

    const move: Move = { from: 'CROSSEX', to: 'LIGHTER' };
    const calls: Call[] = [];
    const { job, before: start, after } = await runLiveJob(recording(clients, calls), {
      route: 'convert',
      steps: [planConvert(ROUND, CONVERT_ARRIVES, move)],
      amount: ROUND,
      costUsd: CONVERT_COST_USD,
    });

    const [, convert] = await expectJob(clients, job, [
      { name: 'Sell USDC', ...move, round: null },
      { name: 'Convert', ...move, round: null, symbol: 'LIGHTER_CONVERT_USDT_USDC' },
    ]);
    const spent = callsOf(calls, 'quote').at(-1)?.amount ?? 0;
    expect(balanceOf(after, GATE_WALLET), 'USDC/GATE cash after').toBeLessThan(DUST_USDC);
    expectNear('USDC/LIGHTER change', changeOf(start, after, LIGHTER_WALLET), qtyOf(convert), MOVE_TOLERANCE);
    expectNear('USDT/CROSSEX change', changeOf(start, after, USDT_WALLET), soldOf(job) - spent, MOVE_TOLERANCE);
  }, 1_500_000);

  it('Convert from Lighter to USDT', async () => {
    const amount = envAmount(LIGHTER_TO_USDT_VAR, LIGHTER_TO_USDT_MIN);
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    logBalances('before', before);
    const cash = balanceOf(before, LIGHTER_WALLET);
    if (!(cash >= amount)) {
      throw new Error(`USDC/LIGHTER cash ${cash} is under ${amount}. Nothing was sent.`);
    }
    const gateCash = balanceOf(before, GATE_WALLET);
    if (!(gateCash < DUST_USDC)) {
      throw new Error(`USDC/GATE cash ${gateCash} is not under ${DUST_USDC}. The job would add a Sell USDC step. Nothing was sent.`);
    }

    budget.beforeOrder(amount, 'Convert from Lighter to USDT');

    const move: Move = { from: 'LIGHTER', to: 'CROSSEX' };
    const { job, before: start, after } = await runLiveJob(clients, {
      route: 'convert',
      steps: [planConvert(amount, nearestCents(amount * (1 - CONVERT_RATE)), move)],
      amount,
      costUsd: nearestCents(amount * CONVERT_RATE),
    });

    const [convert] = await expectJob(clients, job, [
      { name: 'Convert', ...move, round: null, symbol: 'LIGHTER_CONVERT_USDC_USDT' },
    ]);
    expect(job.fundsAt).toBe('CROSSEX');
    expectNear('USDT/CROSSEX change', changeOf(start, after, USDT_WALLET), qtyOf(convert), MOVE_TOLERANCE);
    expectNear('USDC/LIGHTER change', changeOf(start, after, LIGHTER_WALLET), -amount, MOVE_TOLERANCE);
    expect(qtyOf(convert), 'Convert qty against the quote floor').toBeGreaterThanOrEqual(quoteFloor(amount, 'USDT', await readSpotTicker(clients).catch(() => null)));
  }, 900_000);

  it('Convert from Hyperliquid to Lighter in two halves', async () => {
    const amount = envAmount(HL_TO_LIGHTER_VAR, HL_TO_LIGHTER_MIN);
    await convertBetweenVenues(amount, { from: 'HYPERLIQUID', to: 'LIGHTER' }, [
      'HYPERLIQUID_CONVERT_USDC_USDT',
      'LIGHTER_CONVERT_USDT_USDC',
    ]);
  }, 1_500_000);

  it('Convert from Lighter to Hyperliquid in two halves', async () => {
    await convertBetweenVenues(ROUND, { from: 'LIGHTER', to: 'HYPERLIQUID' }, [
      'LIGHTER_CONVERT_USDC_USDT',
      'HYPERLIQUID_CONVERT_USDT_USDC',
    ]);
  }, 1_500_000);

  it('Convert in two parts, each way between Hyperliquid and Lighter and between CrossEx and Hyperliquid', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    await convertInParts({ from: 'HYPERLIQUID', to: 'LIGHTER' }, VENUE_PART, ['HYPERLIQUID_CONVERT_USDC_USDT', 'LIGHTER_CONVERT_USDT_USDC']);
    await convertInParts({ from: 'LIGHTER', to: 'HYPERLIQUID' }, VENUE_PART, ['LIGHTER_CONVERT_USDC_USDT', 'HYPERLIQUID_CONVERT_USDT_USDC']);
    await convertInParts({ from: 'CROSSEX', to: 'HYPERLIQUID' }, USDT_PART, ['HYPERLIQUID_CONVERT_USDT_USDC']);
    await convertInParts({ from: 'HYPERLIQUID', to: 'CROSSEX' }, USDT_PART, ['HYPERLIQUID_CONVERT_USDC_USDT']);
  }, 3_000_000);

  it('a Lighter wallet borrow is repaid by a Convert into Lighter', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const account = await readAccount(clients);
    const assets = account.assets ?? [];
    logBalances('before', assets);
    logWallet('before', assets, LIGHTER_WALLET);
    const gateCash = balanceOf(assets, GATE_WALLET);
    if (!(gateCash < DUST_USDC)) {
      throw new Error(`USDC/GATE cash ${gateCash} is not under ${DUST_USDC}. The repay would add a Sell USDC step. Nothing was sent.`);
    }
    const ratio = marginRatio(account);
    console.log(`  ▸ marginBalance=${account.marginBalance} initialMargin=${account.initialMargin} ratio=${ratio}`);
    if (!(ratio >= MARGIN_RATIO_MIN)) {
      throw new Error(`marginBalance / initialMargin is ${ratio}, under ${MARGIN_RATIO_MIN}. Nothing was sent.`);
    }
    const lighter = row(assets, LIGHTER_WALLET);
    if (liabilityOf(lighter) > LIABILITY_MIN) {
      throw new Error(
        `USDC/LIGHTER already has a borrow of ${lighter?.liability}. Repay it with a Convert into Lighter first. Nothing was sent.`,
      );
    }
    const setup = floorCents(Number(lighter?.equity ?? 0) + BORROW_OVER_EQUITY_USDC);
    if (setup > HARD_NOTIONAL_CEILING_USDT) {
      throw new Error('Lighter equity is too high for a 100 USDC setup. Nothing was sent.');
    }

    budget.beforeOrder(setup, 'Lighter borrow setup');

    const move: Move = { from: 'CROSSEX', to: 'LIGHTER' };
    let received: number | null = null;
    let borrowed: CrossexAccountAsset[] = [];
    let repay: Ran | null = null;
    try {
      received = await convertOutOfLighter(clients, setup);
      borrowed = await waitLighter(clients, 'after the setup', (asset) => liabilityOf(asset) > LIABILITY_MIN);
    } finally {
      if (received !== null) {
        const size = floorCents(received);
        const stillOpen = `USDC/LIGHTER may still have a borrow. Run a Convert of ${size} USDT from USDT · CrossEx into USDC · Lighter.`;
        try {
          budget.beforeOrder(received, 'Lighter borrow repay');
          console.log(`  ▸ repaying ${size} USDT into USDC · Lighter`);
          repay = await runLiveJob(clients, {
            route: 'convert',
            steps: [planConvert(size, 0, move)],
            amount: size,
            costUsd: nearestCents(size * CONVERT_RATE),
          });
        } catch (err) {
          console.error(`  ▸ the repay did not run to the end. ${stillOpen}`);
          throw err;
        }
        if (repay.job.status !== 'done') console.error(`  ▸ the repay stopped. ${stillOpen}`);
      }
    }
    if (!repay) throw new Error('The setup Convert did not run, so there is nothing to repay.');

    expect(liabilityOf(row(borrowed, LIGHTER_WALLET)), 'USDC/LIGHTER liability after the setup').toBeGreaterThan(LIABILITY_MIN);
    const [convert] = await expectJob(clients, repay.job, [
      { name: 'Convert', ...move, round: null, symbol: 'LIGHTER_CONVERT_USDT_USDC' },
    ]);
    expectNear(
      'USDC/LIGHTER change across the repay',
      changeOf(repay.before, repay.after, LIGHTER_WALLET),
      qtyOf(convert),
      MOVE_TOLERANCE,
    );
    const settled = await waitLighter(clients, 'after the repay', (asset) => liabilityOf(asset) <= LIABILITY_LEFT);
    expect(liabilityOf(row(settled, LIGHTER_WALLET)), 'USDC/LIGHTER liability after the repay').toBeLessThanOrEqual(LIABILITY_LEFT);
    const end = await readAccount(clients);
    console.log(`  ▸ marginBalance=${end.marginBalance} initialMargin=${end.initialMargin} ratio=${marginRatio(end)}`);
    expect(marginRatio(end), 'marginBalance / initialMargin after the repay').toBeGreaterThanOrEqual(MARGIN_RATIO_MIN);
  }, 1_200_000);

  it('restart during From Lighter: boot finds the transfer by its tag, stops before To Gate, and Resume sells the USDC', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const account = await readAccount(clients);
    const before = account.assets ?? [];
    logBalances('before', before);
    const spare = spareOf(before, LIGHTER_WALLET);
    if (!(spare >= ROUND)) {
      throw new Error(`USDC/LIGHTER spare cap ${spare} is below ${ROUND} USDC. Nothing was sent.`);
    }
    const gateCash = balanceOf(before, GATE_WALLET);
    if (!(gateCash < DUST_USDC)) {
      throw new Error(`USDC/GATE cash ${gateCash} is not under ${DUST_USDC}. The job would sell it too. Nothing was sent.`);
    }

    budget.beforeOrder(ROUND, 'restart during From Lighter');

    const move: Move = { from: 'LIGHTER', to: 'CROSSEX' };
    const { dataDir, job, step } = writeRunningJob({
      route: 'loop',
      steps: [planRound(1, move, ROUND)],
      amount: ROUND,
      costUsd: 0,
      userId: userIdOf(account),
    });
    const tag = String(step.text);
    const { body } = await sendLogged(
      'From Lighter',
      tag,
      dataDir,
      `${ROUND} USDC may be on its way from USDC · Lighter to Gate spot.`,
      () =>
        clients.crossEx.createCrossexTransfer({
          crossexTransferRequest: { coin: 'USDC', amount: String(ROUND), from: 'CROSSEX_LIGHTER', to: 'SPOT', text: tag },
        }),
    );
    const txId = String(body.txId);
    console.log(`  ▸ Gate took From Lighter txId=${txId} text=${body.text}. rebalance.json keeps venueId null.`);

    const calls: Call[] = [];
    const { app, jobs, getInTransit, postJob } = await bootApp(recording(clients, calls), dataDir);
    try {
      const stopped = await waitStatus(jobs, ['halted', 'done'], HL_TRANSFER_TIMEOUT_MS);
      logJob(stopped, dataDir);
      const [fromLighter] = stopped.steps;
      const boot = {
        status: stopped.status,
        haltReason: stopped.haltReason,
        stepIndex: stopped.stepIndex,
        venueId: fromLighter.venueId,
        stepStatus: fromLighter.status,
      };
      const moved = fromLighter.qty;
      const inTransit = await getInTransit();
      expect(boot).toEqual({ status: 'halted', haltReason: HALT_TEXT.restart, stepIndex: 1, venueId: txId, stepStatus: 'done' });
      expect(
        calls.filter((call) => call.key === tag),
        'sends with the From Lighter tag',
      ).toHaveLength(0);
      expect(inTransit).toEqual({ coin: 'USDC', qty: moved, at: 'SPOT' });

      await postJob('resume', job.id);
      const ended = await waitStatus(jobs, ['done', 'halted'], STEP_TIMEOUT_MS);
      logJob(ended, dataDir);
      const after = await readAssets(clients);
      logBalances('after', after);

      await expectJob(clients, ended, [
        { name: 'From Lighter', ...move, round: 1 },
        { name: 'To Gate', ...move, round: 1 },
        { name: 'Sell USDC', ...move, round: 1 },
      ]);
      expectNear('USDC/LIGHTER change', changeOf(before, after, LIGHTER_WALLET), -ROUND, MOVE_TOLERANCE);
      expectNear('USDT/CROSSEX change', changeOf(before, after, USDT_WALLET), soldOf(ended), MOVE_TOLERANCE);
    } finally {
      await app.close();
    }
  }, 2_500_000);

  it('restart after To spot on a round into Lighter: boot finds the transfer, Abandon keeps the USDC counted once, and Manual Transfer opens again', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const account = await readAccount(clients);
    const before = account.assets ?? [];
    logBalances('before', before);
    const cash = balanceOf(before, USDT_WALLET);
    if (!(cash > ROUND)) {
      throw new Error(`USDT/CROSSEX balance ${cash} is not above ${ROUND}. Nothing was sent.`);
    }
    const gateCash = balanceOf(before, GATE_WALLET);
    if (!(gateCash < DUST_USDC)) {
      throw new Error(`USDC/GATE cash ${gateCash} is not under ${DUST_USDC}. Nothing was sent.`);
    }

    budget.beforeOrder(ROUND, 'restart after To spot into Lighter');

    const move: Move = { from: 'CROSSEX', to: 'LIGHTER' };
    const { dataDir, jobs: file, job, step: buy } = writeRunningJob({
      route: 'loop',
      steps: [planRound(1, move, ROUND, ROUND)],
      amount: ROUND,
      costUsd: LIGHTER_DEPOSIT_FEE_USD,
      userId: userIdOf(account),
    });
    const buyTag = String(buy.text);
    const { body: order } = await sendLogged(
      'Buy USDC',
      buyTag,
      dataDir,
      `${ROUND} USDT may have bought USDC into USDC · Gate.`,
      () =>
        clients.crossEx.createCrossexOrder({
          crossexOrderRequest: {
            symbol: SPOT_SYMBOL,
            side: CrossexOrderRequest.Side.BUY,
            type: CrossexOrderRequest.Type.MARKET,
            quoteQty: String(ROUND),
            text: buyTag,
          },
        }),
    );
    const orderId = String(order.orderId);
    console.log(`  ▸ Buy USDC orderId=${orderId} text=${order.text}`);
    const bought = await waitBought(clients, orderId);

    const toSpot = job.steps[1];
    const spotTag = tagFor(job.id, 2);
    buy.status = 'done';
    buy.venueId = orderId;
    buy.qty = bought;
    buy.doneAt = Date.now();
    toSpot.status = 'running';
    toSpot.startedAt = Date.now();
    toSpot.text = spotTag;
    job.stepIndex = 1;
    job.tagCount = 2;
    job.fundsAt = 'GATE';
    file.write(job);
    logJob(job, dataDir);

    const { body: sent } = await sendLogged(
      'To spot',
      spotTag,
      dataDir,
      `${floorCents(bought)} USDC may be on its way from USDC · Gate to Gate spot.`,
      () =>
        clients.crossEx.createCrossexTransfer({
          crossexTransferRequest: { coin: 'USDC', amount: String(floorCents(bought)), from: 'CROSSEX_GATE', to: 'SPOT', text: spotTag },
        }),
    );
    const txId = String(sent.txId);
    console.log(`  ▸ Gate took To spot txId=${txId} text=${sent.text}. rebalance.json keeps venueId null.`);

    const calls: Call[] = [];
    const { app, jobs, send, getInTransit, postJob } = await bootApp(recording(clients, calls), dataDir);
    try {
      const stopped = await waitStatus(jobs, ['halted', 'done'], STEP_TIMEOUT_MS);
      logJob(stopped, dataDir);
      const moved = qtyOf(stopped.steps[1]);
      const boot = {
        status: stopped.status,
        haltReason: stopped.haltReason,
        venueId: stopped.steps[1].venueId,
        fundsAt: stopped.fundsAt,
      };
      const inTransit = await getInTransit();
      expect(boot).toEqual({ status: 'halted', haltReason: HALT_TEXT.restart, venueId: txId, fundsAt: 'SPOT' });
      expect(
        calls.filter((call) => call.key === buyTag || call.key === spotTag),
        'sends with the Buy USDC or To spot tag',
      ).toHaveLength(0);
      expect(inTransit).toEqual({ coin: 'USDC', qty: moved, at: 'SPOT' });

      const abandoned = await postJob('abandon', job.id);
      expect(abandoned.status).toBe('abandoned');
      expect(await getInTransit(), 'in transit after Abandon').toEqual({ coin: 'USDC', qty: moved, at: 'SPOT' });

      const gateBefore = balanceOf(await readAssets(clients), GATE_WALLET);
      await send({ coin: 'USDC', from: 'SPOT', to: 'CROSSEX_GATE', amount: floorCents(moved) });
      const after = await readAssets(clients);
      logBalances('after', after);

      expectNear('USDC/GATE change from the Manual Transfer', balanceOf(after, GATE_WALLET) - gateBefore, floorCents(moved), MOVE_TOLERANCE);
      expectNear('USDT/CROSSEX change', changeOf(before, after, USDT_WALLET), -ROUND, CASH_TOLERANCE);
      expect(
        callsOf(calls, 'transfer').filter((call) => call.to === 'CROSSEX_LIGHTER'),
        'transfers into Lighter',
      ).toHaveLength(0);
      expect(await gateTransferRows(clients, 'USDC', tagFor(job.id, 3)), 'Gate rows with the To Lighter tag').toHaveLength(0);
    } finally {
      await app.close();
    }
  }, 900_000);

  it('a lost Lighter Convert is found in the LIGHTER_CONVERT_USDC_USDT history and never sent twice', async () => {
    assertLiveTestsEnabled();
    assertAck();
    assertNotionalCeiling();
    const clients = assertCredentials();

    const account = await readAccount(clients);
    const before = account.assets ?? [];
    logBalances('before', before);
    const lighter = row(before, LIGHTER_WALLET);
    const cash = Number(lighter?.balance ?? 0);
    const equity = Number(lighter?.equity ?? 0);
    if (!(cash >= CONVERT_USDC && equity >= CONVERT_USDC)) {
      throw new Error(`USDC/LIGHTER cash ${cash} or equity ${equity} is under ${CONVERT_USDC}. Nothing was sent.`);
    }

    budget.beforeOrder(CONVERT_USDC, 'Lighter Convert restart');

    const move: Move = { from: 'LIGHTER', to: 'CROSSEX' };
    const { dataDir, jobs: file, job, step } = writeRunningJob({
      route: 'convert',
      steps: [planConvert(CONVERT_USDC, nearestCents(CONVERT_USDC * (1 - CONVERT_RATE)), move)],
      amount: CONVERT_USDC,
      costUsd: nearestCents(CONVERT_USDC * CONVERT_RATE),
      userId: userIdOf(account),
    });
    const { body: quote } = await clients.crossEx.createCrossexConvertQuote({
      crossexConvertQuoteRequest: { exchangeType: 'LIGHTER', fromCoin: 'USDC', toCoin: 'USDT', fromAmount: String(CONVERT_USDC) },
    });
    console.log(`  ▸ quote quoteId=${quote.quoteId} ${quote.fromAmount} USDC to ${quote.toAmount} USDT validMs=${quote.validMs}`);
    const toAmount = Number(quote.toAmount);
    if (!(toAmount >= quoteFloor(CONVERT_USDC, 'USDT', await readSpotTicker(clients).catch(() => null)))) {
      throw new Error(`Convert quote ${quote.toAmount} USDT for ${CONVERT_USDC} USDC is under the quote floor. Nothing was sent.`);
    }
    const quoteId = String(quote.quoteId);
    step.quoteId = quoteId;
    step.qty = toAmount;
    file.write(job);
    const { body } = await sendLogged(
      'Convert',
      `${step.text} quoteId=${quoteId}`,
      dataDir,
      `${CONVERT_USDC} USDC may have been converted from USDC · Lighter into USDT · CrossEx.`,
      () => clients.crossEx.createCrossexConvertOrder({ crossexConvertOrderRequest: { quoteId } }),
    );
    const orderId = String(body.orderId);
    console.log(`  ▸ Convert orderId=${orderId} text=${body.text} step text=${step.text}. rebalance.json keeps venueId null.`);

    const calls: Call[] = [];
    const lossy = withCrossEx(recording(clients, calls), {
      getCrossexOrder: async (key) => {
        if (key === quoteId) {
          console.log(`  ▸ order lookup ${key}: 404 on purpose`);
          throw notFound404();
        }
        return clients.crossEx.getCrossexOrder(key);
      },
    });
    const { app, jobs } = await bootApp(lossy, dataDir);
    try {
      const ended = await waitStatus(jobs, ['done', 'halted'], STEP_TIMEOUT_MS);
      logJob(ended, dataDir);
      if (ended.status !== 'done') {
        console.error(`  ▸ the one Convert, order ${orderId}, should have put about ${toAmount} USDT in USDT · CrossEx.`);
      }
      const after = await readAssets(clients);
      logBalances('after', after);

      expect(callsOf(calls, 'quote'), 'Convert quotes after the restart').toHaveLength(0);
      expect(callsOf(calls, 'convert'), 'Convert orders after the restart').toHaveLength(0);
      expect(callsOf(calls, 'history').map((call) => call.key)).toContain('LIGHTER_CONVERT_USDC_USDT');
      expect(ended.steps[0].venueId, `${ended.status} ${ended.haltReason ?? ''}`).toBe(orderId);
      await expectJob(clients, ended, [{ name: 'Convert', ...move, round: null, symbol: 'LIGHTER_CONVERT_USDC_USDT' }]);
      expectNear('USDT/CROSSEX change', changeOf(before, after, USDT_WALLET), toAmount, MOVE_TOLERANCE);
    } finally {
      await app.close();
    }
  }, 900_000);
});
