import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/server/cache';
import { HALT_TEXT, newTransferJob, TransferFile, type TransferJob } from '../../src/server/rebalanceJob';
import { LOOKUP_RETRY_MS, LOOKUP_WINDOW_MS, POLL_MS, runTransfer } from '../../src/server/rebalanceRunner';
import { clientsWith } from '../helpers/fake-clients';

type Handler = (arg: never) => Promise<unknown>;

const START = 1_000_000;

function fakeClock(stopAfterMs = Infinity) {
  let t = START;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      if (t - START > stopAfterMs) throw new Error('stop');
    },
  };
}

function seq(...items: unknown[]): Handler {
  let i = 0;
  return async () => {
    const item = items[Math.min(i, items.length - 1)];
    i += 1;
    return typeof item === 'function' ? item() : item;
  };
}

const gateError = (status: number, label: string, message: string) => () => {
  throw Object.assign(new Error(message), { response: { status, data: { label, message } } });
};
const networkError = () => {
  throw Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });
};
const tx = (txId: string) => ({ body: { txId, text: 't' } });
const rows = (...list: unknown[]) => ({ body: list });

const tag = `t-tr${START.toString(36)}`;

function harness(
  clock: ReturnType<typeof fakeClock>,
  over: Partial<TransferJob>,
  handlers: Record<string, Handler>,
) {
  const calls: Record<string, unknown[]> = {};
  const sequence: string[] = [];
  const crossEx: Record<string, Handler> = {};
  for (const [name, fn] of Object.entries(handlers)) {
    crossEx[name] = async (arg: never) => {
      (calls[name] ??= []).push(arg);
      sequence.push(name);
      return fn(arg);
    };
  }
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'transfer-'));
  const transfers = new TransferFile(dir, clock.now);
  const transfer = {
    ...newTransferJob({ coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', amount: 11.88, userId: '1' }, clock.now()),
    ...over,
  };
  transfers.write(transfer);
  const cache = new TtlCache();
  const deps = { clients: () => clientsWith(crossEx), transfers, cache, now: clock.now, sleep: clock.sleep };
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'transfer.json'), 'utf8')) as TransferJob;
  const count = (name: string) => calls[name]?.length ?? 0;
  return { calls, sequence, count, cache, onDisk, run: () => runTransfer(deps) };
}

const accepted = { sentAt: START - 5_000, acceptedAt: START - 4_000, venueId: '123' };
const sentNoAnswer = { sentAt: START - 5_000 };

describe('runTransfer polls an accepted transfer', () => {
  it('success writes received', async () => {
    const h = harness(fakeClock(), accepted, {
      listCrossexTransfers: seq(
        rows({ id: 122, status: 'SUCCESS', amount: '5', actualReceive: '5' }),
        rows({ id: 123, status: 'PENDING', amount: '11.88' }),
        rows({ id: 123, status: 'SUCCESS', amount: '11.88', actualReceive: '10.88' }),
      ),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'done', received: 10.88, failText: null, doneAt: START + 2 * POLL_MS });
    expect(h.calls.listCrossexTransfers[0]).toEqual({ coin: 'USDC', limit: 100 });
    expect(h.count('createCrossexTransfer')).toBe(0);
  });

  it('fail writes the reason', async () => {
    const h = harness(fakeClock(), accepted, {
      listCrossexTransfers: seq(rows({ id: '123', status: 'FAIL', amount: '11.88', failReason: 'x' })),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'failed', failText: 'Transfer failed: x.', received: null });
  });

  it('a success with no actualReceive takes off the path fee', async () => {
    const h = harness(fakeClock(), accepted, {
      listCrossexTransfers: seq(rows({ id: '123', status: 'SUCCESS', amount: '11.88' })),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'done', received: 10.88 });
  });

  it('accepted transfer never times out', async () => {
    const h = harness(fakeClock(45 * 60_000), accepted, {
      listCrossexTransfers: seq(rows({ id: '123', status: 'PENDING', amount: '11.88' })),
    });

    await expect(h.run()).rejects.toThrow('stop');

    expect(h.onDisk()).toMatchObject({ status: 'moving', failText: null, doneAt: null });
    expect(h.count('listCrossexTransfers')).toBeGreaterThan((45 * 60_000) / POLL_MS);
  });

  it('keeps polling through a failed read', async () => {
    const h = harness(fakeClock(), accepted, {
      listCrossexTransfers: seq(networkError, rows({ id: '123', status: 'SUCCESS', amount: '11.88', actualReceive: '10.88' })),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'done', received: 10.88 });
  });

  it('returns at once unless the transfer is moving', async () => {
    const h = harness(fakeClock(), { ...accepted, status: 'done' }, {
      listCrossexTransfers: seq(rows()),
      createCrossexTransfer: seq(tx('9')),
    });

    await h.run();

    expect(h.sequence).toEqual([]);
  });
});

describe('runTransfer sends once', () => {
  it('moving written before send', async () => {
    let seen: TransferJob | null = null;
    const h = harness(fakeClock(), {}, {
      createCrossexTransfer: async () => {
        seen = h.onDisk();
        return tx('9');
      },
      listCrossexTransfers: seq(rows({ id: 9, status: 'SUCCESS', amount: '11.88', actualReceive: '10.88' })),
    });

    await h.run();

    expect(seen).toMatchObject({ status: 'moving', text: tag, sentAt: START, venueId: null });
    expect(h.calls.createCrossexTransfer).toEqual([
      { crossexTransferRequest: { coin: 'USDC', amount: '11.88', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT', text: tag } },
    ]);
    expect(h.onDisk()).toMatchObject({ status: 'done', venueId: '9', acceptedAt: START, received: 10.88 });
  });

  it('a send Gate accepts busts the account cache', async () => {
    const values: unknown[] = [];
    const h = harness(fakeClock(), {}, {
      createCrossexTransfer: seq(tx('9')),
      listCrossexTransfers: async () => {
        values.push((await h.cache.get('account', 60_000, async () => 'new')).value);
        return rows({ id: '9', status: 'SUCCESS', amount: '11.88' });
      },
    });
    await h.cache.get('account', 60_000, async () => 'old');

    await h.run();

    expect(values).toEqual(['new']);
  });

  it('lost response looks up', async () => {
    let statusAtLookup: string | null = null;
    const h = harness(fakeClock(), {}, {
      createCrossexTransfer: seq(networkError),
      listCrossexTransfers: seq(
        () => {
          statusAtLookup = h.onDisk().status;
          return rows({ id: 41, text: tag, status: 'PENDING', amount: '11.88' });
        },
        rows({ id: 41, text: tag, status: 'SUCCESS', amount: '11.88', actualReceive: '10.88' }),
      ),
    });

    await h.run();

    expect(statusAtLookup).toBe('moving');
    expect(h.sequence.slice(0, 2)).toEqual(['createCrossexTransfer', 'listCrossexTransfers']);
    expect(h.count('createCrossexTransfer')).toBe(1);
    expect(h.onDisk()).toMatchObject({ status: 'done', venueId: '41', received: 10.88 });
  });

  it('a refused send fails with the margin text', async () => {
    const h = harness(fakeClock(), {}, {
      createCrossexTransfer: seq(
        gateError(422, 'TRANSFER_AMOUNT_INSUFFICIENT', 'Insufficient transferAvailable, transferAvailable: 11.85'),
      ),
      listCrossexTransfers: seq(rows()),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'failed', failText: HALT_TEXT.marginRefused, venueId: null });
    expect(h.count('listCrossexTransfers')).toBe(0);
  });

  it('a spot send over the spot balance says what Gate spot has', async () => {
    const h = harness(fakeClock(), { coin: 'USDT', from: 'SPOT', to: 'CROSSEX', amount: 5000 }, {
      createCrossexTransfer: seq(
        gateError(422, 'TRANSFER_AMOUNT_INSUFFICIENT', 'Insufficient transferAvailable, transferAvailable: 292.0185407'),
      ),
      listCrossexTransfers: seq(rows()),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'failed', failText: 'Gate spot has only 292.01 USDT.', venueId: null });
    expect(h.count('createCrossexTransfer')).toBe(1);
    expect(h.count('listCrossexTransfers')).toBe(0);
  });

  it('a spot send with nothing in spot says Gate spot has none', async () => {
    const h = harness(fakeClock(), { coin: 'USDC', from: 'SPOT', to: 'CROSSEX_GATE', amount: 50 }, {
      createCrossexTransfer: seq(
        gateError(422, 'TRANSFER_AMOUNT_INSUFFICIENT', 'Insufficient transferAvailable, transferAvailable: 0'),
      ),
      listCrossexTransfers: seq(rows()),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'failed', failText: 'Gate spot has no USDC.', venueId: null });
  });

  it('another refused send fails with the Gate message', async () => {
    const h = harness(fakeClock(), {}, {
      createCrossexTransfer: seq(
        gateError(422, 'TRANSFER_AMOUNT_MINTRANS_INVALID_ERROR', 'The Minimum amount needs to be greater than 11'),
      ),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({
      status: 'failed',
      failText: "Transfer failed: below Gate's minimum of 11.",
    });
  });

  it('a transfer that rounds to 0 is never sent', async () => {
    const h = harness(fakeClock(), { amount: 0.000004 }, {
      createCrossexTransfer: seq(tx('9')),
      listCrossexTransfers: seq(rows()),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'failed', failText: 'Transfer failed.', sentAt: null, venueId: null });
    expect(h.sequence).toEqual([]);
  });
});

describe('runTransfer after a restart', () => {
  it('lost send is marked not sent', async () => {
    const lookups: number[] = [];
    const clock = fakeClock();
    const h = harness(clock, sentNoAnswer, {
      listCrossexTransfers: async () => {
        lookups.push(clock.now());
        return rows({ id: 7, text: 't-trother', status: 'SUCCESS', amount: '11.88' });
      },
      createCrossexTransfer: seq(tx('9')),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'failed', failText: 'Gate has no record of this transfer. Try again.' });
    expect(lookups).toEqual(Array.from({ length: LOOKUP_WINDOW_MS / LOOKUP_RETRY_MS + 1 }, (_, i) => START + i * LOOKUP_RETRY_MS));
  });

  it('restart never sends again', async () => {
    const h = harness(fakeClock(), sentNoAnswer, {
      listCrossexTransfers: seq(rows()),
      createCrossexTransfer: seq(tx('9')),
    });

    await h.run();

    expect(h.count('createCrossexTransfer')).toBe(0);
    expect(h.onDisk().status).toBe('failed');
  });

  it('USDT tag is adopted', async () => {
    const h = harness(fakeClock(), { ...sentNoAnswer, coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount: 5 }, {
      listCrossexTransfers: async (arg: { coin: string }) =>
        arg.coin === 'USDT' ? rows({ id: 77, text: tag, status: 'SUCCESS', amount: '5', actualReceive: '5' }) : rows(),
      createCrossexTransfer: seq(tx('9')),
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'done', venueId: '77', received: 5, acceptedAt: START });
    expect(h.count('createCrossexTransfer')).toBe(0);
    for (const arg of h.calls.listCrossexTransfers) expect(arg).toMatchObject({ coin: 'USDT' });
  });

  it('a lookup that fails does not count as no record', async () => {
    const clock = fakeClock();
    const h = harness(clock, sentNoAnswer, {
      listCrossexTransfers: async () => {
        if (clock.now() - START <= LOOKUP_WINDOW_MS) return networkError();
        return rows({ id: 8, text: tag, status: 'SUCCESS', amount: '11.88', actualReceive: '10.88' });
      },
    });

    await h.run();

    expect(h.onDisk()).toMatchObject({ status: 'done', venueId: '8' });
  });
});
