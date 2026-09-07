import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CrossexAccountAsset } from 'gate-api';
import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/server/cache';
import { JobFile, newJob } from '../../src/server/rebalanceJob';
import { HL_TRANSFER_TIMEOUT_MS, runJob } from '../../src/server/rebalanceRunner';
import { budget } from './env';
import { assertAck, assertCredentials, assertLiveTestsEnabled } from './guards';

const AMOUNT = 12;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const row = (list: CrossexAccountAsset[], coin: string, venue: string) =>
  list.find((a) => a.coin === coin && a.exchangeType === venue);

describe.skipIf(process.env.REBALANCE !== '1')('live rebalance — 12 USDT down to Hyperliquid, 12 USDC back', () => {
  it('buys USDC, moves it to spot, then to Hyperliquid', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const assets = async (): Promise<CrossexAccountAsset[]> =>
      (await clients.crossEx.getCrossexAccount()).body.assets ?? [];

    const before = await assets();
    const liability = Number(row(before, 'USDC', 'HYPERLIQUID')?.liability ?? 0);
    const cash = Number(row(before, 'USDT', 'CROSSEX')?.balance ?? 0);
    if (!(liability > AMOUNT)) {
      throw new Error(`USDC/HYPERLIQUID liability ${liability} is not above ${AMOUNT}. Nothing to pay down.`);
    }
    if (!(cash > AMOUNT)) {
      throw new Error(`USDT/CROSSEX balance ${cash} is not above ${AMOUNT}. Not enough cash to buy USDC.`);
    }
    const balanceBefore = Number(row(before, 'USDC', 'HYPERLIQUID')?.balance ?? 0);

    budget.beforeOrder(AMOUNT, 'rebalance loop');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebalance-live-'));
    const jobs = new JobFile(dataDir);
    const job = newJob('payDown', 'loop', AMOUNT, Date.now());
    jobs.write(job);
    console.log(`  ▸ job ${job.id} written to ${dataDir}`);

    await runJob({ clients: () => clients, jobs, cache: new TtlCache(), now: Date.now, sleep, log: console.error });

    console.log(`  ▸ job ${job.id}: ${job.status}${job.haltReason ? ` (${job.haltReason})` : ''} fundsAt=${job.fundsAt}`);
    for (const step of job.steps) {
      console.log(`  ▸ ${step.name}: status=${step.status} venueId=${step.venueId} qty=${step.qty}`);
    }

    expect(job.status).toBe('done');
    expect(job.steps).toHaveLength(3);
    for (const step of job.steps) {
      expect(step.status).toBe('done');
      expect(step.venueId).not.toBeNull();
    }

    const balanceAfter = Number(row(await assets(), 'USDC', 'HYPERLIQUID')?.balance ?? 0);
    const landed = job.steps[2].qty ?? 0;
    console.log(`  ▸ USDC/HYPERLIQUID balance ${balanceBefore} → ${balanceAfter} (step 3 qty ${landed})`);
    expect(Math.abs(balanceAfter - balanceBefore - landed)).toBeLessThanOrEqual(0.01);
  }, 400_000);

  it('pull: moves USDC from Hyperliquid to spot, then to Gate, then sells it for USDT', async (ctx) => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const assets = async (): Promise<CrossexAccountAsset[]> =>
      (await clients.crossEx.getCrossexAccount()).body.assets ?? [];

    const before = await assets();
    const usdc = row(before, 'USDC', 'HYPERLIQUID');
    const cap = Math.min(Number(usdc?.availableBalance ?? 0), Number(usdc?.equity ?? 0));
    if (!(cap >= AMOUNT)) {
      ctx.skip(`USDC/HYPERLIQUID pull cap ${cap} is below ${AMOUNT} USDC. Nothing to pull.`);
    }
    const cashBefore = Number(row(before, 'USDT', 'CROSSEX')?.balance ?? 0);

    budget.beforeOrder(AMOUNT, 'rebalance pull');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebalance-live-'));
    const jobs = new JobFile(dataDir);
    const job = newJob('pull', 'loop', AMOUNT, Date.now());
    jobs.write(job);
    console.log(`  ▸ job ${job.id} written to ${dataDir}`);

    await runJob({ clients: () => clients, jobs, cache: new TtlCache(), now: Date.now, sleep, log: console.error });

    console.log(`  ▸ job ${job.id}: ${job.status}${job.haltReason ? ` (${job.haltReason})` : ''} fundsAt=${job.fundsAt}`);
    for (const step of job.steps) {
      console.log(`  ▸ ${step.name}: status=${step.status} venueId=${step.venueId} qty=${step.qty}`);
    }

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
});
