import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatCrossPrice, roundToStep, stripZeros } from '../../src/core/numbers';
import { resolveQty } from '../../src/core/orders';
import {
  ceilCents,
  fit,
  floorCents,
  nearestCents,
  spotOrderMax,
  transferPaths,
  type AccountLike,
  type CoinRuleLike,
  type SpotBalance,
  type TransferPath,
} from '../../src/core/rebalance/plan';
import { TtlCache } from '../../src/server/cache';
import { newTransferJob, spotShortfallFailText, TransferFile } from '../../src/server/rebalanceJob';
import { isSendable, receivedOf, runTransfer } from '../../src/server/rebalanceRunner';
import { clientsWith } from '../helpers/fake-clients';

type TransferRecord = Parameters<typeof receivedOf>[0];

const RUNGS = [
  { usd: '$50', x: 50, under: '49.99', under5: '49.99999', shown: '49.99' },
  { usd: '$5,000', x: 5_000, under: '4999.99', under5: '4999.99999', shown: '4,999.99' },
  { usd: '$100,000', x: 100_000, under: '99999.99', under5: '99999.99999', shown: '99,999.99' },
  { usd: '$1,000,000', x: 1_000_000, under: '999999.99', under5: '999999.99999', shown: '999,999.99' },
  { usd: '$6,000,000', x: 6_000_000, under: '5999999.99', under5: '5999999.99999', shown: '5,999,999.99' },
] as const;

const hairsUnderCent = (x: number): number[] => [
  x - 0.004,
  x - 0.000001,
  x - 0.0000001,
  Number(`${x - 1}.996`),
  Number(`${x - 1}.9999`),
  Number(`${x - 1}.99999999`),
];

const hairsUnderStep = (x: number): number[] => [x - 0.0000001, x - 0.00000001, Number(`${x - 1}.99999999`)];

const hairsOverCent = (x: number): number[] => [x + 0.004, x + 0.000001, Number(`${x}.00000001`)];

const centAt = (x: number, i: number): number =>
  Number(`${Math.floor((x * (i + 1)) / 500)}.${String((i * 37) % 100).padStart(2, '0')}`);

const centsSample = (x: number): number[] => Array.from({ length: 500 }, (_, i) => centAt(x, i));

describe('floorCents at every rung', () => {
  it.each(RUNGS)('$usd: a balance a hair under a cent floors to $under', ({ x, under }) => {
    for (const value of hairsUnderCent(x)) {
      expect(floorCents(value)).toBe(Number(under));
      expect(floorCents(value)).toBeLessThanOrEqual(value);
    }
    expect(floorCents(x)).toBe(x);
    expect(floorCents(Number(`${x}.29`))).toBe(Number(`${x}.29`));
  });

  it.each(RUNGS)('$usd: a float sum that is one cent step in truth keeps that step', ({ x }) => {
    expect(floorCents(x + 0.3 - 0.1)).toBe(Number(`${x}.2`));
    expect(floorCents(x + 0.1 + 0.2)).toBe(Number(`${x}.3`));
    expect(floorCents(Number(`${x}.01`) - 1)).toBe(Number(`${x - 1}.01`));
  });

  it.each(RUNGS)('$usd: 500 cents values up to the rung come back unchanged', ({ x }) => {
    for (const c of centsSample(x)) {
      expect(floorCents(c)).toBe(c);
      expect(ceilCents(c)).toBe(c);
      expect(nearestCents(c)).toBe(c);
    }
  });
});

describe('ceilCents at every rung', () => {
  it.each(RUNGS)('$usd: a value a hair over the rung rounds up to one cent over', ({ x }) => {
    for (const value of hairsOverCent(x)) {
      expect(ceilCents(value)).toBe(Number(`${x}.01`));
      expect(ceilCents(value)).toBeGreaterThanOrEqual(value);
    }
    expect(ceilCents(x)).toBe(x);
    expect(ceilCents(x - 0.004)).toBe(x);
  });
});

describe('nearestCents at every rung', () => {
  it.each(RUNGS)('$usd: rounds to the nearest cent on both sides of the rung', ({ x, under }) => {
    expect(nearestCents(x - 0.004)).toBe(x);
    expect(nearestCents(x + 0.004)).toBe(x);
    expect(nearestCents(Number(`${x - 1}.994`))).toBe(Number(under));
    expect(nearestCents(x)).toBe(x);
  });
});

describe('spotOrderMax under the CrossEx rule of 5,000,000', () => {
  it.each([
    [1.0007, 4_896_572.39],
    [1.03, 4_757_281.55],
  ])('at price %d one Buy or Sell USDC order is exactly %d USDC', (price, cap) => {
    expect(spotOrderMax(price, 5_000_000)).toBe(cap);
  });
});

describe('fit at every rung', () => {
  it.each(RUNGS)('$usd: cash a hair under a cent with ample margin fits $under, never over cash', ({ x, under }) => {
    for (const cash of hairsUnderCent(x)) {
      const size = fit({ marginBalance: 10 * x, initialMargin: x }, cash, 10 * x);
      expect(size).toBe(Number(under));
      expect(size).toBeLessThanOrEqual(cash);
    }
  });
});

const COINS: CoinRuleLike[] = [
  { coin: 'USDT', minTransAmount: 0.00000001, estFee: 0, isDisabled: 0 },
  { coin: 'USDC', minTransAmount: 11, estFee: 1, isDisabled: 0 },
];

const pathOf = (paths: TransferPath[], coin: string, from: string, to: string): TransferPath => {
  const found = paths.find((p) => p.coin === coin && p.from === from && p.to === to);
  if (!found) throw new Error(`no path ${coin} ${from} to ${to}`);
  return found;
};

const cashRow = (coin: string, exchangeType: string, balance: string, equity: number) => ({
  coin,
  exchangeType,
  balance,
  equity: String(equity),
  borrowingInitialMargin: '0',
  borrowingMaintenanceMargin: '0',
});

describe('transferPaths max at every rung', () => {
  it.each(RUNGS)('$usd: a spot or CrossEx balance a hair under a cent gives a max of $under', ({ x, under }) => {
    const usdt = `${x - 1}.99999999`;
    const usdc = `${x - 1}.996`;
    const account: AccountLike = {
      availableMargin: String(10 * x),
      marginBalance: String(10 * x),
      initialMargin: String(x),
      assets: [cashRow('USDT', 'CROSSEX', usdt, 10 * x), cashRow('USDC', 'GATE', usdc, 10 * x)],
    };
    const spot: SpotBalance[] = [
      { coin: 'USDT', available: Number(usdt), locked: 0 },
      { coin: 'USDC', available: Number(usdc), locked: 0 },
    ];
    const paths = transferPaths({ account, spot, coins: COINS });
    for (const [coin, from, to, balance] of [
      ['USDT', 'SPOT', 'CROSSEX', usdt],
      ['USDC', 'SPOT', 'CROSSEX_GATE', usdc],
      ['USDT', 'CROSSEX', 'SPOT', usdt],
      ['USDC', 'CROSSEX_GATE', 'SPOT', usdc],
    ] as const) {
      const max = pathOf(paths, coin, from, to).max;
      expect(max).toBe(Number(under));
      expect(max ?? Infinity).toBeLessThanOrEqual(Number(balance));
    }
  });
});

async function wireAmount(amount: number): Promise<string> {
  let now = 1_000_000;
  const sent: { crossexTransferRequest: { amount: string } }[] = [];
  const crossEx = {
    createCrossexTransfer: async (arg: { crossexTransferRequest: { amount: string } }) => {
      sent.push(arg);
      return { body: { txId: '9', text: 't' } };
    },
    listCrossexTransfers: async () => ({
      body: [{ id: 9, status: 'SUCCESS', actualReceive: String(amount), amount: String(amount) }],
    }),
  };
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'money-at-size-'));
  const transfers = new TransferFile(dir, () => now);
  transfers.write(newTransferJob({ coin: 'USDT', from: 'SPOT', to: 'CROSSEX', amount, userId: '1' }, now));
  await runTransfer({
    clients: () => clientsWith(crossEx),
    transfers,
    cache: new TtlCache(),
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  expect(sent).toHaveLength(1);
  return sent[0].crossexTransferRequest.amount;
}

describe('Manual Transfer wire amount at every rung', () => {
  it.each(RUNGS)('$usd: an amount a hair under a 0.00001 step sends $under5', async ({ x, under5 }) => {
    for (const amount of hairsUnderStep(x)) {
      const sent = await wireAmount(amount);
      expect(sent).toBe(under5);
      expect(Number(sent)).toBeLessThanOrEqual(amount);
    }
  });

  it.each(RUNGS)('$usd: a cents amount goes out as typed', async ({ x }) => {
    expect(await wireAmount(Number(`${x}.12`))).toBe(`${x}.12`);
    expect(await wireAmount(x)).toBe(String(x));
  });

  it.each(RUNGS)('$usd: isSendable is true a hair under the rung', ({ x }) => {
    for (const amount of hairsUnderStep(x)) expect(isSendable(amount)).toBe(true);
    expect(isSendable(0.00000999)).toBe(false);
    expect(isSendable(0.00001)).toBe(true);
  });
});

describe('receivedOf at every rung', () => {
  it.each(RUNGS)('$usd: amount plus 0.01 less the 1 USDC Hyperliquid fee keeps its last cent', ({ x }) => {
    const row: Partial<TransferRecord> = { actualReceive: '0', amount: `${x}.01` };
    const received = receivedOf(row as TransferRecord, { coin: 'USDC', from: 'CROSSEX_HYPERLIQUID', to: 'SPOT' });
    expect(received).toBe(Number(`${x - 1}.01`));
  });
});

describe('spotShortfallFailText at every rung', () => {
  it.each(RUNGS)('$usd: Gate spot available a hair under a cent shows $shown', ({ x, shown }) => {
    const text = spotShortfallFailText(`Insufficient transferAvailable, transferAvailable: ${x - 1}.996`, 'USDT', x);
    expect(text).toBe(`Gate spot has only ${shown} USDT.`);
  });

  it('$6,000,000: transferAvailable 5999999.996 shows 5,999,999.99', () => {
    const text = spotShortfallFailText('transferAvailable: 5999999.996', 'USDT', 6_000_000);
    expect(text).toBe('Gate spot has only 5,999,999.99 USDT.');
  });
});

describe('Sell qty and Convert fromAmount at every rung', () => {
  it.each(RUNGS)('$usd: Gate cash a hair under a cent goes out as $under on the cent step', ({ x, under }) => {
    for (const cash of hairsUnderCent(x)) {
      const qty = roundToStep(floorCents(cash), '0.01', 'down');
      expect(qty).toBe(under);
      expect(stripZeros(qty)).toBe(under);
      expect(Number(qty)).toBeLessThanOrEqual(cash);
    }
  });
});

describe('formatCrossPrice at every rung', () => {
  it.each(RUNGS)('$usd: a BUY never rounds under the price and a SELL never over it', ({ x, under }) => {
    for (const price of hairsOverCent(x)) {
      expect(formatCrossPrice(price, 'BUY', 'GATE_FUTURE_X_USDT', '0.01')).toBe(`${x}.01`);
    }
    for (const price of hairsUnderCent(x)) {
      expect(formatCrossPrice(price, 'SELL', 'GATE_FUTURE_X_USDT', '0.01')).toBe(under);
    }
    expect(formatCrossPrice(x, 'BUY', 'GATE_FUTURE_X_USDT', '0.01')).toBe(String(x));
  });
});

describe('close size on a 0.1 lot at every rung', () => {
  const qtyFor = (qty: number): string =>
    resolveQty({ qty: String(qty), refPrice: 1, legs: [{ lotSize: '0.1', minSize: 0, minNotional: 0 }] }).qtyStr;

  it.each(RUNGS)('$usd: resolveQty keeps a one-lot float result', ({ x }) => {
    expect(qtyFor(x + 0.3 - 0.1)).toBe(`${x}.2`);
    expect(qtyFor(x + 0.1 + 0.2)).toBe(`${x}.3`);
    expect(qtyFor(Number(`${x - 1}.99999999`))).toBe(`${x - 1}.9`);
  });

  const closes = [
    [0.3 - 0.1, '0.2'],
    [0.1 + 0.2, '0.3'],
    [3000.3 - 0.1, '3000.2'],
    [1234567.8 - 0.1, '1234567.7'],
    [5999999.9 - 0.1, '5999999.8'],
  ] as const;

  it.each(closes)('resolveQty sizes %s at %s', (qty, want) => {
    expect(qtyFor(qty)).toBe(want);
  });

  it.each(closes)('the close-size lot floor keeps %s at %s', (qty, want) => {
    expect(roundToStep(qty, '0.1', 'down')).toBe(want);
    expect(roundToStep(Math.abs(Number(String(qty))), '0.1', 'down')).toBe(want);
  });

  it.each(RUNGS)('$usd: the close-size lot floor keeps a one-lot float result', ({ x }) => {
    expect(roundToStep(x + 0.3 - 0.1, '0.1', 'down')).toBe(`${x}.2`);
    expect(roundToStep(x + 0.1 + 0.2, '0.1', 'down')).toBe(`${x}.3`);
    expect(roundToStep(Number(`${x - 1}.99999999`), '0.1', 'down')).toBe(`${x - 1}.9`);
  });
});

describe('roundToStep at every rung and step', () => {
  it.each(RUNGS)('$usd: an 8-decimal balance under a step never rounds up', ({ x }) => {
    const balance = `${x - 1}.99999999`;
    for (const [step, want] of [
      ['0.01', `${x - 1}.99`],
      ['0.001', `${x - 1}.999`],
      ['0.0001', `${x - 1}.9999`],
      ['0.00001', `${x - 1}.99999`],
      ['0.1', `${x - 1}.9`],
      ['1', `${x - 1}`],
    ] as const) {
      expect(roundToStep(Number(balance), step, 'down')).toBe(want);
      expect(roundToStep(Number(`${x}.00000001`), step, 'up')).toBe(roundToStep(x, step, 'up').replace(/\d$/, '1'));
      expect(roundToStep(x, step, 'down')).toBe(roundToStep(x, step, 'up'));
    }
  });

  it.each(RUNGS)('$usd: prints without exponent notation', ({ x }) => {
    for (const step of ['0.01', '0.00001', '1e-5']) {
      expect(roundToStep(x, step, 'down')).not.toMatch(/e/i);
      expect(roundToStep(x - 0.0000001, step, 'up')).not.toMatch(/e/i);
    }
  });
});
