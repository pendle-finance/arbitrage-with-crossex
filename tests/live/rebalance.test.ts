import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CrossexAccountAsset } from 'gate-api';
import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/server/cache';
import { JobFile, newJob } from '../../src/server/rebalanceJob';
import { runJob } from '../../src/server/rebalanceRunner';
import { budget } from './env';
import { assertAck, assertCredentials, assertLiveTestsEnabled } from './guards';

const AMOUNT = 12;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(process.env.REBALANCE !== '1')('live rebalance — loop route with 12 USDT', () => {
  it('buys USDC, moves it to spot, then to Hyperliquid', async () => {
    assertLiveTestsEnabled();
    assertAck();
    const clients = assertCredentials();

    const assets = async (): Promise<CrossexAccountAsset[]> =>
      (await clients.crossEx.getCrossexAccount()).body.assets ?? [];
    const row = (list: CrossexAccountAsset[], coin: string, venue: string) =>
      list.find((a) => a.coin === coin && a.exchangeType === venue);

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
    const job = newJob('loop', AMOUNT, Date.now());
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
});
