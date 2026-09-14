import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CrossexAccountAsset } from 'gate-api';
import { describe, expect, it } from 'vitest';
import type { GateAccount, PlannedStep } from '../../src/core/rebalance/plan';
import { Store } from '../../src/engine/db';
import { gateVenue } from '../../src/engine/venueGate';
import { buildApp } from '../../src/server/app';
import { TtlCache } from '../../src/server/cache';
import { JobFile, newJob, TransferFile, type Job, type TransferJob } from '../../src/server/rebalanceJob';
import { HL_TRANSFER_TIMEOUT_MS, POLL_MS, runJob } from '../../src/server/rebalanceRunner';
import { budget } from './env';
import { assertAck, assertCredentials, assertLiveTestsEnabled } from './guards';

const ROUND = 12;
const ROUNDS = 2;
const TRANSFER_USDT = 5;
const TOKEN = 'live-rebalance-token';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const row = (list: CrossexAccountAsset[], coin: string, venue: string) =>
  list.find((a) => a.coin === coin && a.exchangeType === venue);

const logJob = (job: Job): void => {
  console.log(`  ▸ job ${job.id}: ${job.status}${job.haltReason ? ` (${job.haltReason})` : ''} fundsAt=${job.fundsAt}`);
  for (const step of job.steps) {
    console.log(`  ▸ round ${step.round} ${step.name}: status=${step.status} venueId=${step.venueId} qty=${step.qty}`);
  }
};

describe.skipIf(process.env.REBALANCE !== '1')('live rebalance rounds and manual transfer', () => {
  it('two rounds toward USDC', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const assets = async (): Promise<CrossexAccountAsset[]> =>
      (await clients.crossEx.getCrossexAccount()).body.assets ?? [];

    const before = await assets();
    const cash = Number(row(before, 'USDT', 'CROSSEX')?.balance ?? 0);
    if (!(cash > ROUND * ROUNDS)) {
      throw new Error(`USDT/CROSSEX balance ${cash} is not above ${ROUND * ROUNDS}. Not enough cash for two rounds.`);
    }
    const liability = Number(row(before, 'USDC', 'HYPERLIQUID')?.liability ?? 0);
    const balanceBefore = Number(row(before, 'USDC', 'HYPERLIQUID')?.balance ?? 0);

    budget.beforeOrder(ROUND * ROUNDS, 'rebalance two rounds');

    const round = (n: number): PlannedStep => ({
      round: n,
      kind: 'round',
      buy: ROUND,
      move: ROUND,
      arrives: ROUND - 0.05,
      borrowLeft: Math.max(0, liability - n * (ROUND - 0.05)),
      seconds: 130,
    });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebalance-live-'));
    const jobs = new JobFile(dataDir);
    const job = newJob(
      {
        direction: 'toUsdc',
        route: 'loop',
        steps: [round(1), round(2)],
        amount: ROUND * ROUNDS,
        costUsd: 0.05 * ROUNDS,
        target: [],
        userId: null,
      },
      Date.now(),
    );
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

    expect(job.status).toBe('done');
    const arrivals = job.steps.filter((step) => step.name === 'To Hyperliquid');
    expect(arrivals).toHaveLength(ROUNDS);
    for (const step of job.steps) expect(step.status).toBe('done');

    const arrived = arrivals.reduce((total, step) => total + (step.qty ?? 0), 0);
    const balanceAfter = Number(row(await assets(), 'USDC', 'HYPERLIQUID')?.balance ?? 0);
    console.log(`  ▸ USDC/HYPERLIQUID balance ${balanceBefore} → ${balanceAfter} (arrived ${arrived})`);
    expect(Math.abs(balanceAfter - balanceBefore - arrived)).toBeLessThanOrEqual(0.01);
  }, ROUNDS * 400_000);

  it('toUsdt: moves USDC from Hyperliquid to spot, then to Gate, then sells it for USDT', async (ctx) => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const assets = async (): Promise<CrossexAccountAsset[]> =>
      (await clients.crossEx.getCrossexAccount()).body.assets ?? [];

    const before = await assets();
    const usdc = row(before, 'USDC', 'HYPERLIQUID');
    const cap = Math.min(Number(usdc?.availableBalance ?? 0), Number(usdc?.equity ?? 0));
    if (!(cap >= ROUND)) {
      ctx.skip(`USDC/HYPERLIQUID spare cap ${cap} is below ${ROUND} USDC. Nothing to move.`);
    }
    const cashBefore = Number(row(before, 'USDT', 'CROSSEX')?.balance ?? 0);

    budget.beforeOrder(ROUND, 'rebalance toUsdt');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebalance-live-'));
    const jobs = new JobFile(dataDir);
    const job = newJob(
      {
        direction: 'toUsdt',
        route: 'loop',
        steps: [{ round: 1, kind: 'round', buy: 0, move: ROUND, arrives: ROUND - 1, borrowLeft: 0, seconds: 400 }],
        amount: ROUND,
        costUsd: 1,
        target: [],
        userId: null,
      },
      Date.now(),
    );
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

    expect(job.status).toBe('done');
    expect(job.fundsAt).toBe('CROSSEX');
    expect(job.steps).toHaveLength(3);
    for (const step of job.steps) {
      expect(step.status).toBe('done');
      expect(step.venueId).not.toBeNull();
    }

    const cashAfter = Number(row(await assets(), 'USDT', 'CROSSEX')?.balance ?? 0);
    const sold = job.steps[2].qty ?? 0;
    console.log(`  ▸ USDT/CROSSEX balance ${cashBefore} → ${cashAfter} (step 3 qty ${sold})`);
    expect(Math.abs(cashAfter - cashBefore - sold)).toBeLessThanOrEqual(0.01);
  }, HL_TRANSFER_TIMEOUT_MS + 200_000);

  it('manual transfer round trip', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const cashOf = async (): Promise<number> =>
      Number(row((await clients.crossEx.getCrossexAccount()).body.assets ?? [], 'USDT', 'CROSSEX')?.balance ?? 0);

    const cashBefore = await cashOf();
    if (!(cashBefore > TRANSFER_USDT)) {
      throw new Error(`USDT/CROSSEX balance ${cashBefore} is not above ${TRANSFER_USDT}. Nothing to move.`);
    }

    budget.beforeOrder(TRANSFER_USDT, 'manual transfer round trip');

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

    const send = async (from: GateAccount, to: GateAccount): Promise<TransferJob> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/transfer',
        headers,
        payload: { coin: 'USDT', from, to, amount: String(TRANSFER_USDT) },
      });
      expect(res.statusCode, res.body).toBe(202);
      const deadline = Date.now() + 120_000;
      while (transfers.read()?.status === 'moving') {
        if (Date.now() > deadline) throw new Error(`USDT ${from} to ${to} still moving after 120 s`);
        await sleep(POLL_MS);
      }
      const transfer = transfers.read();
      if (!transfer) throw new Error(`transfer.json in ${dataDir} is unreadable`);
      console.log(`  ▸ USDT ${from} to ${to}: ${transfer.status} venueId=${transfer.venueId} received=${transfer.received}`);
      return { ...transfer };
    };

    try {
      const out = await send('CROSSEX', 'SPOT');
      const back = await send('SPOT', 'CROSSEX');

      const { body: rows } = await clients.crossEx.listCrossexTransfers({ coin: 'USDT', limit: 100 });
      for (const transfer of [out, back]) {
        expect(transfer.status).toBe('done');
        expect(rows.find((r) => String(r.id) === transfer.venueId)?.status).toBe('SUCCESS');
      }

      const cashAfter = await cashOf();
      console.log(`  ▸ USDT/CROSSEX balance ${cashBefore} → ${cashAfter}`);
      expect(Math.abs(cashAfter - cashBefore)).toBeLessThanOrEqual(0.01);
    } finally {
      await app.close();
    }
  }, 300_000);
});
