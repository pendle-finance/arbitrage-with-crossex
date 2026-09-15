import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CrossexAccountAsset } from 'gate-api';
import { describe, expect, it } from 'vitest';
import type { Clients } from '../../src/core/clients';
import {
  floorCents,
  HYPERLIQUID_DEPOSIT_FEE_USD,
  HYPERLIQUID_MIN_USDC,
  TO_USDC_WAIT_SECONDS,
  type GateAccount,
  type PlannedStep,
  type TransferCoin,
} from '../../src/core/rebalance/plan';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { buildApp } from '../../src/server/app';
import { TtlCache } from '../../src/server/cache';
import { JobFile, newJob, TransferFile, type Job, type TransferJob } from '../../src/server/rebalanceJob';
import { HL_TRANSFER_TIMEOUT_MS, POLL_MS, runJob } from '../../src/server/rebalanceRunner';
import { sleep } from '../../src/server/routes/rebalance';
import { budget } from './env';
import { assertAck, assertCredentials, assertLiveTestsEnabled } from './guards';

const ROUND = 12;
const ROUNDS = 2;
const ROUND_TIMEOUT_MS = 400_000;
const TRANSFER_USDT = 5;
const USDC_ROUND_TRIP = 12.5;
const HYPERLIQUID_WAIT_MS = 900_000;
const QUICK_WAIT_MS = 120_000;
const TOKEN = 'live-rebalance-token';

const CONVERT_STEP: PlannedStep = {
  round: null,
  kind: 'convert',
  buy: 0,
  move: ROUND,
  arrives: 11.97,
  borrowLeft: 0,
  seconds: 0,
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

const runLiveJob = async (
  clients: Clients,
  input: Omit<Parameters<typeof newJob>[0], 'target' | 'userId'>,
): Promise<Job> => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebalance-live-'));
  const jobs = new JobFile(dataDir);
  const job = newJob({ ...input, target: [], userId: null }, Date.now());
  jobs.write(job);
  console.log(`  ▸ job ${job.id} written to ${dataDir}`);

  await runJob({
    clients: () => clients,
    jobs,
    cache: new TtlCache(),
    now: Date.now,
    sleep,
    onHalt: (halted) => console.error(`  ▸ halted: ${halted.haltReason}`),
  });
  logJob(job);
  return job;
};

type TransferLeg = { coin: TransferCoin; from: GateAccount; to: GateAccount; amount: number };

const startTransferApp = (clients: Clients) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-live-'));
  const transfers = new TransferFile(dataDir);
  const app = buildApp({
    getClients: () => clients,
    cache: new TtlCache(),
    authToken: TOKEN,
    engine: { store: new Store(':memory:'), venue: gateVenue(() => clients), clock: { now: Date.now } },
    transfer: { jobs: transfers, sleep },
  });
  const headers = { host: 'localhost:6688', 'x-arb-token': TOKEN };

  const send = async ({ coin, from, to, amount }: TransferLeg): Promise<TransferJob> => {
    const before = await readAssets(clients);
    const res = await app.inject({
      method: 'POST',
      url: '/api/transfer',
      headers,
      payload: { coin, from, to, amount: String(amount) },
    });
    expect(res.statusCode, res.body).toBe(202);
    const waitMs = from === 'CROSSEX_HYPERLIQUID' || to === 'CROSSEX_HYPERLIQUID' ? HYPERLIQUID_WAIT_MS : QUICK_WAIT_MS;
    const deadline = Date.now() + waitMs;
    while (transfers.read()?.status === 'moving') {
      if (Date.now() > deadline) throw new Error(`${coin} ${from} to ${to} still moving after ${waitMs / 1000} s`);
      await sleep(POLL_MS);
    }
    const transfer = transfers.read();
    if (!transfer) throw new Error(`transfer.json in ${dataDir} is unreadable`);
    const after = await readAssets(clients);
    console.log(
      `  ▸ ${coin} ${from} to ${to}: ${transfer.status} venueId=${transfer.venueId} amount=${amount} received=${transfer.received}`,
    );
    console.log(`  ▸ before ${formatBalances(before, coin)} after ${formatBalances(after, coin)}`);
    return { ...transfer };
  };

  return { app, send };
};

const expectGateSuccess = async (clients: Clients, coin: TransferCoin, sent: TransferJob[]): Promise<void> => {
  const { body: rows } = await clients.crossEx.listCrossexTransfers({ coin, limit: 100 });
  for (const transfer of sent) {
    expect(transfer.status).toBe('done');
    expect(rows.find((r) => String(r.id) === transfer.venueId)?.status).toBe('SUCCESS');
  }
};

describe.skipIf(process.env.REBALANCE !== '1')('live rebalance rounds and manual transfer', () => {
  it('two rounds toward USDC', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    const cash = balanceOf(before, 'USDT', 'CROSSEX');
    if (!(cash > ROUND * ROUNDS)) {
      throw new Error(`USDT/CROSSEX balance ${cash} is not above ${ROUND * ROUNDS}. Not enough cash for two rounds.`);
    }
    const liability = Number(row(before, 'USDC', 'HYPERLIQUID')?.liability ?? 0);
    const balanceBefore = balanceOf(before, 'USDC', 'HYPERLIQUID');

    budget.beforeOrder(ROUND * ROUNDS, 'rebalance two rounds');

    const job = await runLiveJob(clients, {
      direction: 'toUsdc',
      route: 'loop',
      steps: [planRound(1, liability), planRound(2, liability)],
      amount: ROUND * ROUNDS,
      costUsd: HYPERLIQUID_DEPOSIT_FEE_USD * ROUNDS,
    });

    expect(job.status).toBe('done');
    const arrivals = job.steps.filter((step) => step.name === 'To Hyperliquid');
    expect(arrivals).toHaveLength(ROUNDS);
    for (const step of job.steps) expect(step.status).toBe('done');

    const arrived = arrivals.reduce((total, step) => total + (step.qty ?? 0), 0);
    const balanceAfter = balanceOf(await readAssets(clients), 'USDC', 'HYPERLIQUID');
    console.log(`  ▸ USDC/HYPERLIQUID balance ${balanceBefore} → ${balanceAfter} (arrived ${arrived})`);
    expect(Math.abs(balanceAfter - balanceBefore - arrived)).toBeLessThanOrEqual(0.01);
  }, ROUNDS * ROUND_TIMEOUT_MS);

  it('toUsdt: moves USDC from Hyperliquid to spot, then to Gate, then sells it for USDT', async (ctx) => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    const usdc = row(before, 'USDC', 'HYPERLIQUID');
    const cap = Math.min(Number(usdc?.availableBalance ?? 0), Number(usdc?.equity ?? 0));
    if (!(cap >= ROUND)) {
      ctx.skip(`USDC/HYPERLIQUID spare cap ${cap} is below ${ROUND} USDC. Nothing to move.`);
    }
    const cashBefore = balanceOf(before, 'USDT', 'CROSSEX');

    budget.beforeOrder(ROUND, 'rebalance toUsdt');

    const job = await runLiveJob(clients, {
      direction: 'toUsdt',
      route: 'loop',
      steps: [{ round: 1, kind: 'round', buy: 0, move: ROUND, arrives: ROUND - 1, borrowLeft: 0, seconds: 400 }],
      amount: ROUND,
      costUsd: 1,
    });

    expect(job.status).toBe('done');
    expect(job.fundsAt).toBe('CROSSEX');
    expect(job.steps).toHaveLength(3);
    for (const step of job.steps) {
      expect(step.status).toBe('done');
      expect(step.venueId).not.toBeNull();
    }

    const cashAfter = balanceOf(await readAssets(clients), 'USDT', 'CROSSEX');
    const sold = job.steps[2].qty ?? 0;
    console.log(`  ▸ USDT/CROSSEX balance ${cashBefore} → ${cashAfter} (step 3 qty ${sold})`);
    expect(Math.abs(cashAfter - cashBefore - sold)).toBeLessThanOrEqual(0.01);
  }, HL_TRANSFER_TIMEOUT_MS + 200_000);

  it('manual transfer round trip', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const cashBefore = balanceOf(await readAssets(clients), 'USDT', 'CROSSEX');
    if (!(cashBefore > TRANSFER_USDT)) {
      throw new Error(`USDT/CROSSEX balance ${cashBefore} is not above ${TRANSFER_USDT}. Nothing to move.`);
    }

    budget.beforeOrder(TRANSFER_USDT, 'manual transfer round trip');

    const { app, send } = startTransferApp(clients);
    try {
      const out = await send({ coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount: TRANSFER_USDT });
      const back = await send({ coin: 'USDT', from: 'SPOT', to: 'CROSSEX', amount: TRANSFER_USDT });
      await expectGateSuccess(clients, 'USDT', [out, back]);

      const cashAfter = balanceOf(await readAssets(clients), 'USDT', 'CROSSEX');
      console.log(`  ▸ USDT/CROSSEX balance ${cashBefore} → ${cashAfter}`);
      expect(Math.abs(cashAfter - cashBefore)).toBeLessThanOrEqual(0.01);
    } finally {
      await app.close();
    }
  }, 300_000);

  it('manual USDC round trip through the four USDC paths', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    const usdc = row(before, 'USDC', 'HYPERLIQUID');
    const cap = Math.min(Number(usdc?.availableBalance ?? 0), Number(usdc?.equity ?? 0));
    if (!(cap >= USDC_ROUND_TRIP)) {
      throw new Error(`USDC/HYPERLIQUID spare cap ${cap} is below ${USDC_ROUND_TRIP} USDC. Nothing to move.`);
    }
    const balanceBefore = balanceOf(before, 'USDC', 'HYPERLIQUID');

    budget.beforeOrder(USDC_ROUND_TRIP, 'manual USDC round trip');

    const legs: [GateAccount, GateAccount][] = [
      ['CROSSEX_HYPERLIQUID', 'SPOT'],
      ['SPOT', 'CROSSEX_GATE'],
      ['CROSSEX_GATE', 'SPOT'],
      ['SPOT', 'CROSSEX_HYPERLIQUID'],
    ];
    const { app, send } = startTransferApp(clients);
    try {
      const sent: TransferJob[] = [];
      let amount = USDC_ROUND_TRIP;
      for (const [from, to] of legs) {
        if (to === 'CROSSEX_HYPERLIQUID' && amount < HYPERLIQUID_MIN_USDC) {
          throw new Error(
            `${amount} USDC is under the ${HYPERLIQUID_MIN_USDC} USDC minimum into the CrossEx Hyperliquid wallet. It stays in Gate spot.`,
          );
        }
        const transfer = await send({ coin: 'USDC', from, to, amount });
        expect(transfer.status, transfer.failText ?? '').toBe('done');
        sent.push(transfer);
        amount = floorCents(transfer.received ?? 0);
      }
      await expectGateSuccess(clients, 'USDC', sent);

      const arrived = sent.at(-1)?.received ?? 0;
      const balanceAfter = balanceOf(await readAssets(clients), 'USDC', 'HYPERLIQUID');
      console.log(
        `  ▸ USDC/HYPERLIQUID balance ${balanceBefore} → ${balanceAfter} (sent ${USDC_ROUND_TRIP}, arrived ${arrived})`,
      );
      expect(Math.abs(balanceAfter - (balanceBefore - USDC_ROUND_TRIP + arrived))).toBeLessThanOrEqual(0.02);
    } finally {
      await app.close();
    }
  }, 2 * HYPERLIQUID_WAIT_MS + 3 * QUICK_WAIT_MS);

  it('mix toward USDC: one round then Convert', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const amount = 2 * ROUND;
    const before = await readAssets(clients);
    const cash = balanceOf(before, 'USDT', 'CROSSEX');
    if (!(cash > amount)) {
      throw new Error(`USDT/CROSSEX balance ${cash} is not above ${amount}. Not enough cash for one round and a Convert.`);
    }
    const liability = Number(row(before, 'USDC', 'HYPERLIQUID')?.liability ?? 0);
    const balanceBefore = balanceOf(before, 'USDC', 'HYPERLIQUID');

    budget.beforeOrder(amount, 'rebalance mix');

    const job = await runLiveJob(clients, {
      direction: 'toUsdc',
      route: 'mix',
      steps: [planRound(1, liability), CONVERT_STEP],
      amount,
      costUsd: 0.08,
    });

    expect(job.status).toBe('done');
    expect([
      ['Buy USDC', 'To spot', 'To Hyperliquid', 'Convert'],
      ['Buy USDC', 'To spot', 'To Hyperliquid', 'Sell USDC', 'Convert'],
    ]).toContainEqual(job.steps.map((step) => step.name));
    for (const step of job.steps) {
      expect(step.status).toBe('done');
      expect(step.venueId).not.toBeNull();
    }

    const arrived = job.steps
      .filter((step) => step.name === 'To Hyperliquid' || step.name === 'Convert')
      .reduce((total, step) => total + (step.qty ?? 0), 0);
    const balanceAfter = balanceOf(await readAssets(clients), 'USDC', 'HYPERLIQUID');
    console.log(`  ▸ USDC/HYPERLIQUID balance ${balanceBefore} → ${balanceAfter} (arrived ${arrived})`);
    expect(Math.abs(balanceAfter - balanceBefore - arrived)).toBeLessThanOrEqual(0.02);
  }, ROUND_TIMEOUT_MS + QUICK_WAIT_MS);

  it('Convert toward USDT', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const before = await readAssets(clients);
    const usdc = balanceOf(before, 'USDC', 'HYPERLIQUID');
    if (!(usdc >= ROUND)) {
      throw new Error(`USDC/HYPERLIQUID balance ${usdc} is under ${ROUND}. Nothing to convert.`);
    }
    const cashBefore = balanceOf(before, 'USDT', 'CROSSEX');

    budget.beforeOrder(ROUND, 'rebalance Convert toUsdt');

    const job = await runLiveJob(clients, {
      direction: 'toUsdt',
      route: 'convert',
      steps: [CONVERT_STEP],
      amount: ROUND,
      costUsd: 0.03,
    });

    expect(job.status).toBe('done');
    expect(job.fundsAt).toBe('CROSSEX');
    expect(job.steps.map((step) => step.name)).toEqual(['Convert']);
    const [convert] = job.steps;
    expect(convert.status).toBe('done');
    expect(convert.venueId).not.toBeNull();

    const cashAfter = balanceOf(await readAssets(clients), 'USDT', 'CROSSEX');
    console.log(`  ▸ USDT/CROSSEX balance ${cashBefore} → ${cashAfter} (Convert qty ${convert.qty})`);
    expect(Math.abs(cashAfter - cashBefore - (convert.qty ?? 0))).toBeLessThanOrEqual(0.02);
  }, QUICK_WAIT_MS);
});
