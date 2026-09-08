import { CrossexOrderRequest, type CrossexTransferRecord } from 'gate-api';
import type { Clients } from '../core/clients';
import { classifyGateError } from '../core/errors';
import { roundToStep } from '../core/numbers';
import { SPOT_SYMBOL } from '../core/rebalance/plan';
import { decodeStatus } from '../engine/loop';
import type { TtlCache } from './cache';
import { haltMessage, type FundsAt, type JobFile, type Step, type StepName } from './rebalanceJob';

export interface RunnerDeps {
  clients: () => Clients;
  jobs: JobFile;
  cache: TtlCache;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export const STEP_TIMEOUT_MS = 600_000;
export const HL_TRANSFER_TIMEOUT_MS = 1_800_000;
export const POLL_MS = 1_000;
export const LOOKUP_RETRY_MS = 10_000;
export const QUOTE_FLOOR = 0.997;
export const TRANSFER_STEP = '0.00001';
const SELL_STEP = '0.01';
const HYPERLIQUID_ACCOUNT = 'CROSSEX_HYPERLIQUID';

const NOT_FOUND = /NOT_FOUND/i;
const TRANSFER_DEAD = /FAIL|CANCEL|REJECT|EXPIRE/i;

type StepSpec =
  | { kind: 'order'; side: CrossexOrderRequest.Side; dest: FundsAt }
  | { kind: 'transfer'; from: string; to: string; dest: FundsAt }
  | { kind: 'convert'; dest: FundsAt };

const STEPS: Record<StepName, StepSpec> = {
  'Buy USDC': { kind: 'order', side: CrossexOrderRequest.Side.BUY, dest: 'GATE' },
  'To spot': { kind: 'transfer', from: 'CROSSEX_GATE', to: 'SPOT', dest: 'SPOT' },
  'To Hyperliquid': { kind: 'transfer', from: 'SPOT', to: HYPERLIQUID_ACCOUNT, dest: 'HYPERLIQUID' },
  Convert: { kind: 'convert', dest: 'HYPERLIQUID' },
  'From Hyperliquid': { kind: 'transfer', from: HYPERLIQUID_ACCOUNT, to: 'SPOT', dest: 'SPOT' },
  'To Gate': { kind: 'transfer', from: 'SPOT', to: 'CROSSEX_GATE', dest: 'GATE' },
  'Sell USDC': { kind: 'order', side: CrossexOrderRequest.Side.SELL, dest: 'CROSSEX' },
};

const timeoutFor = (spec: StepSpec): number =>
  spec.kind === 'transfer' && (spec.from === HYPERLIQUID_ACCOUNT || spec.to === HYPERLIQUID_ACCOUNT)
    ? HL_TRANSFER_TIMEOUT_MS
    : STEP_TIMEOUT_MS;

export function tagFor(jobId: string, stepIndex: number, attempt = 0): string {
  return attempt > 0 ? `t-rb${jobId}${stepIndex}x${attempt}` : `t-rb${jobId}${stepIndex}`;
}

export async function runJob(deps: RunnerDeps): Promise<void> {
  const job = deps.jobs.read();
  if (!job) return;
  const crossEx = () => deps.clients().crossEx;

  const halt = (reason: string): void => {
    job.status = 'halted';
    job.haltReason = reason;
    deps.jobs.write(job);
    deps.log(haltMessage(job));
  };

  const haltDead = (step: Step, reason: string): void => {
    step.venueId = null;
    step.text = null;
    step.quoteId = null;
    step.attempt += 1;
    halt(reason);
  };

  const finish = (step: Step, qty: number, fundsAt: FundsAt): void => {
    step.qty = qty;
    step.status = 'done';
    step.doneAt = deps.now();
    job.fundsAt = fundsAt;
    if (fundsAt === 'HYPERLIQUID' || fundsAt === 'CROSSEX') deps.cache.bust('account');
    if (job.stepIndex === job.steps.length - 1) job.status = 'done';
    else job.stepIndex += 1;
    deps.jobs.write(job);
  };

  const previousQty = (): number => (job.stepIndex === 0 ? job.amount : (job.steps[job.stepIndex - 1].qty ?? 0));

  /** Convert runs on Hyperliquid in both directions. Toward USDC it turns USDT
   * into USDC there; toward USDT it turns USDC into USDT, which lands in the
   * pooled CROSSEX bucket. */
  const convertSpec = () =>
    job.direction === 'toUsdt'
      ? { fromCoin: 'USDC', toCoin: 'USDT', dest: 'CROSSEX' as FundsAt }
      : { fromCoin: 'USDT', toCoin: 'USDC', dest: 'HYPERLIQUID' as FundsAt };

  const transferRow = async (
    match: (row: CrossexTransferRecord) => boolean,
  ): Promise<CrossexTransferRecord | null> => {
    const { body } = await crossEx().listCrossexTransfers({ coin: 'USDC', limit: 100 });
    return (body ?? []).find(match) ?? null;
  };

  const poll = async (step: Step, spec: StepSpec, venueId: string): Promise<void> => {
    if (spec.kind !== 'transfer') {
      const { body } = await crossEx().getCrossexOrder(venueId);
      const state = String(body.state ?? '');
      if (decodeStatus(state) !== 'closed') return;
      let filled: number;
      if (spec.kind === 'convert' || spec.side === CrossexOrderRequest.Side.SELL) {
        // Gate books a convert as a market sell of the from coin, so what came
        // back is executedAmount, as for a spot sell.
        filled = Number(body.executedAmount ?? 0);
      } else {
        const fee = String(body.feeCoin ?? '') === 'USDC' ? Number(body.fee ?? 0) : 0;
        filled = Number(body.executedQty ?? 0) - (Number.isFinite(fee) ? fee : 0);
      }
      if (filled > 0) finish(step, filled, spec.kind === 'convert' ? convertSpec().dest : spec.dest);
      else haltDead(step, `order ${state} with nothing filled`);
    } else {
      const row = await transferRow((r) => r.id === venueId);
      if (!row) return;
      const status = String(row.status ?? '');
      if (status === 'SUCCESS') {
        const received = Number(row.actualReceive ?? row.amount);
        if (received > 0) finish(step, received, spec.dest);
        else halt('transfer SUCCESS with nothing received');
      } else if (TRANSFER_DEAD.test(status)) {
        haltDead(step, row.failReason || `transfer ${status}`);
      }
    }
  };

  /** The venue id of a send whose response was lost, or null when Gate has
   * no record of it. A transfer is found by its tag; an order by its tag,
   * which Gate resolves on the order endpoint; a convert by its quote id,
   * which Gate stores as the convert order's text (checked live 2026-09-07). */
  const lookup = async (spec: StepSpec, key: string): Promise<string | null> => {
    if (spec.kind === 'transfer') {
      const row = await transferRow((r) => r.text === key);
      return row ? row.id : null;
    }
    try {
      const { body } = await crossEx().getCrossexOrder(key);
      return body.orderId ? String(body.orderId) : null;
    } catch (err) {
      const c = classifyGateError(err);
      if (c.httpStatus === 404 || NOT_FOUND.test(c.label ?? '')) return null;
      throw err;
    }
  };

  const transfer = async (from: string, to: string, tag: string): Promise<string> => {
    const { body } = await crossEx().createCrossexTransfer({
      crossexTransferRequest: {
        coin: 'USDC',
        amount: roundToStep(previousQty(), TRANSFER_STEP, 'down'),
        from,
        to,
        text: tag,
      },
    });
    if (!body.txId) throw new Error('transfer response has no txId');
    return String(body.txId);
  };

  const sendConvert = async (step: Step): Promise<void> => {
    const spec = convertSpec();
    const { body: quote } = await crossEx().createCrossexConvertQuote({
      crossexConvertQuoteRequest: {
        exchangeType: 'HYPERLIQUID',
        fromCoin: spec.fromCoin,
        toCoin: spec.toCoin,
        fromAmount: String(job.amount),
      },
    });
    const toAmount = Number(quote.toAmount);
    if (!(toAmount >= job.amount * QUOTE_FLOOR)) {
      halt('quote worse than 30 bps');
      return;
    }
    // On disk before the send: if the response is lost, the quote id is the
    // key that finds the order on Gate, so the step is never sent twice.
    step.quoteId = String(quote.quoteId);
    step.qty = toAmount;
    deps.jobs.write(job);
    const { body } = await crossEx().createCrossexConvertOrder({
      crossexConvertOrderRequest: { quoteId: step.quoteId },
    });
    if (!body.orderId) throw new Error('convert order response has no orderId');
    step.venueId = String(body.orderId);
    finish(step, toAmount, spec.dest);
  };

  const send = async (step: Step, spec: StepSpec, tag: string): Promise<void> => {
    if (spec.kind === 'convert') return sendConvert(step);
    if (spec.kind === 'order') {
      const size =
        spec.side === CrossexOrderRequest.Side.SELL
          ? { qty: roundToStep(previousQty(), SELL_STEP, 'down') }
          : { quoteQty: String(job.amount) };
      const { body } = await crossEx().createCrossexOrder({
        crossexOrderRequest: {
          symbol: SPOT_SYMBOL,
          side: spec.side,
          type: CrossexOrderRequest.Type.MARKET,
          ...size,
          text: tag,
        },
      });
      if (!body.orderId) throw new Error('order response has no orderId');
      step.venueId = String(body.orderId);
    } else {
      step.venueId = await transfer(spec.from, spec.to, tag);
    }
    deps.jobs.write(job);
  };

  try {
    while (job.status === 'running') {
      const step = job.steps[job.stepIndex];
      const spec: StepSpec | undefined = STEPS[step.name as StepName];
      if (!spec) {
        halt(`unknown step ${step.name}`);
        return;
      }
      if (step.startedAt === null) {
        step.startedAt = deps.now();
        step.status = 'running';
        deps.jobs.write(job);
      }
      if (deps.now() - step.startedAt > timeoutFor(spec)) {
        halt('timeout');
        return;
      }
      let phase: 'poll' | 'lookup' | 'send' = 'poll';
      try {
        if (step.venueId !== null) {
          await poll(step, spec, step.venueId);
          if (job.status === 'running' && step.status !== 'done') await deps.sleep(POLL_MS);
          continue;
        }
        if (step.text === null) {
          step.text = tagFor(job.id, job.stepIndex, step.attempt);
          deps.jobs.write(job);
        } else {
          // A tag with no venue id: a send may have gone through and lost its
          // response. Ask Gate twice, 10 s apart, before sending again. A
          // convert with no quote id never reached the order call.
          const key = spec.kind === 'convert' ? step.quoteId : step.text;
          if (key !== null) {
            phase = 'lookup';
            let found = await lookup(spec, key);
            if (found === null) {
              await deps.sleep(LOOKUP_RETRY_MS);
              found = await lookup(spec, key);
            }
            if (found !== null) {
              step.venueId = found;
              deps.jobs.write(job);
              continue;
            }
          }
        }
        phase = 'send';
        await send(step, spec, step.text);
      } catch (err) {
        const c = classifyGateError(err);
        const notFound = c.httpStatus === 404 || NOT_FOUND.test(c.label ?? '');
        if (c.retryable || (phase === 'poll' && notFound)) {
          await deps.sleep(POLL_MS);
        } else if (phase !== 'send') {
          halt(c.message);
        } else if (c.label && c.httpStatus !== undefined && c.httpStatus >= 400 && c.httpStatus < 500) {
          halt(c.hint ? `${c.message} ${c.hint}` : c.message);
        } else {
          await deps.sleep(POLL_MS);
        }
      }
    }
  } catch (err) {
    job.status = 'halted';
    job.haltReason = classifyGateError(err).message;
    try {
      deps.jobs.write(job);
    } catch {}
    deps.log(haltMessage(job));
  }
}
