import { CrossexOrderRequest, type CrossexTransferRecord } from 'gate-api';
import type { Clients } from '../core/clients';
import { classifyGateError } from '../core/errors';
import { roundToStep } from '../core/numbers';
import { SPOT_SYMBOL } from '../core/rebalance/plan';
import { decodeStatus } from '../engine/loop';
import type { TtlCache } from './cache';
import { haltMessage, STEP_NAMES, type FundsAt, type JobFile, type Step } from './rebalanceJob';

export interface RunnerDeps {
  clients: () => Clients;
  jobs: JobFile;
  cache: TtlCache;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export const STEP_TIMEOUT_MS = 600_000;
export const POLL_MS = 1_000;
export const LOOKUP_RETRY_MS = 10_000;
export const QUOTE_FLOOR = 0.997;
export const TRANSFER_STEP = '0.00001';

const NOT_FOUND = /NOT_FOUND/i;
const TRANSFER_DEAD = /FAIL|CANCEL|REJECT|EXPIRE/i;

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
    step.attempt += 1;
    halt(reason);
  };

  const finish = (step: Step, qty: number, fundsAt: FundsAt): void => {
    step.qty = qty;
    step.status = 'done';
    step.doneAt = deps.now();
    job.fundsAt = fundsAt;
    if (fundsAt === 'HYPERLIQUID') deps.cache.bust('account');
    if (job.stepIndex === job.steps.length - 1) job.status = 'done';
    else job.stepIndex += 1;
    deps.jobs.write(job);
  };

  const usdcOnHyperliquid = async (): Promise<number> => {
    const { body } = await crossEx().getCrossexAccount();
    const asset = body.assets?.find((a) => a.coin === 'USDC' && a.exchangeType === 'HYPERLIQUID');
    return Number(asset?.balance ?? 0);
  };

  const transferRow = async (
    match: (row: CrossexTransferRecord) => boolean,
  ): Promise<CrossexTransferRecord | null> => {
    const { body } = await crossEx().listCrossexTransfers({ coin: 'USDC', limit: 100 });
    return (body ?? []).find(match) ?? null;
  };

  const convertLanded = async (step: Step): Promise<boolean> => {
    const balance = await usdcOnHyperliquid();
    if (step.balanceBefore === null || step.qty === null || balance - step.balanceBefore < step.qty - 0.01) {
      return false;
    }
    finish(step, step.qty, 'HYPERLIQUID');
    return true;
  };

  const poll = async (step: Step, venueId: string): Promise<void> => {
    if (step.name === 'Buy USDC') {
      const { body } = await crossEx().getCrossexOrder(venueId);
      const state = String(body.state ?? '');
      if (decodeStatus(state) !== 'closed') return;
      const fee = String(body.feeCoin ?? '') === 'USDC' ? Number(body.fee ?? 0) : 0;
      const filled = Number(body.executedQty ?? 0) - (Number.isFinite(fee) ? fee : 0);
      if (filled > 0) finish(step, filled, 'GATE');
      else haltDead(step, `order ${state} with nothing filled`);
    } else if (step.name === 'Convert') {
      await convertLanded(step);
    } else {
      const row = await transferRow((r) => r.id === venueId);
      if (!row) return;
      const status = String(row.status ?? '');
      if (status === 'SUCCESS') {
        const received = Number(row.actualReceive ?? row.amount);
        if (received > 0) finish(step, received, step.name === 'To spot' ? 'SPOT' : 'HYPERLIQUID');
        else halt('transfer SUCCESS with nothing received');
      } else if (TRANSFER_DEAD.test(status)) {
        haltDead(step, row.failReason || `transfer ${status}`);
      }
    }
  };

  const lookup = async (step: Step, tag: string): Promise<string | null> => {
    if (step.name !== 'Buy USDC') {
      const row = await transferRow((r) => r.text === tag);
      return row ? row.id : null;
    }
    try {
      const { body } = await crossEx().getCrossexOrder(tag);
      return body.orderId ? String(body.orderId) : null;
    } catch (err) {
      const c = classifyGateError(err);
      if (c.httpStatus === 404 || NOT_FOUND.test(c.label ?? '')) return null;
      throw err;
    }
  };

  const transfer = async (from: string, to: string, tag: string): Promise<string> => {
    const amount = job.steps[job.stepIndex - 1].qty ?? 0;
    const { body } = await crossEx().createCrossexTransfer({
      crossexTransferRequest: { coin: 'USDC', amount: roundToStep(amount, TRANSFER_STEP, 'down'), from, to, text: tag },
    });
    if (!body.txId) throw new Error('transfer response has no txId');
    return String(body.txId);
  };

  const sendConvert = async (step: Step): Promise<void> => {
    if (step.balanceBefore === null) step.balanceBefore = await usdcOnHyperliquid();
    const { body: quote } = await crossEx().createCrossexConvertQuote({
      crossexConvertQuoteRequest: {
        exchangeType: 'HYPERLIQUID',
        fromCoin: 'USDT',
        toCoin: 'USDC',
        fromAmount: String(job.amount),
      },
    });
    const toAmount = Number(quote.toAmount);
    if (!(toAmount >= job.amount * QUOTE_FLOOR)) {
      halt('quote worse than 30 bps');
      return;
    }
    step.quoteId = String(quote.quoteId);
    step.qty = toAmount;
    deps.jobs.write(job);
    const { body } = await crossEx().createCrossexConvertOrder({
      crossexConvertOrderRequest: { quoteId: step.quoteId },
    });
    if (!body.orderId) throw new Error('convert order response has no orderId');
    step.venueId = String(body.orderId);
    finish(step, toAmount, 'HYPERLIQUID');
  };

  const send = async (step: Step, tag: string): Promise<void> => {
    if (step.name === 'Convert') return sendConvert(step);
    if (step.name === 'Buy USDC') {
      const { body } = await crossEx().createCrossexOrder({
        crossexOrderRequest: {
          symbol: SPOT_SYMBOL,
          side: CrossexOrderRequest.Side.BUY,
          type: CrossexOrderRequest.Type.MARKET,
          quoteQty: String(job.amount),
          text: tag,
        },
      });
      if (!body.orderId) throw new Error('order response has no orderId');
      step.venueId = String(body.orderId);
    } else if (step.name === 'To spot') {
      step.venueId = await transfer('CROSSEX_GATE', 'SPOT', tag);
    } else if (step.name === 'To Hyperliquid') {
      step.venueId = await transfer('SPOT', 'CROSSEX_HYPERLIQUID', tag);
    }
    deps.jobs.write(job);
  };

  try {
    while (job.status === 'running') {
      const step = job.steps[job.stepIndex];
      if (!STEP_NAMES.includes(step.name)) {
        halt(`unknown step ${step.name}`);
        return;
      }
      if (step.startedAt === null) {
        step.startedAt = deps.now();
        step.status = 'running';
        deps.jobs.write(job);
      }
      if (deps.now() - step.startedAt > STEP_TIMEOUT_MS) {
        halt('timeout');
        return;
      }
      let phase: 'poll' | 'lookup' | 'send' = 'poll';
      try {
        if (step.venueId !== null) {
          await poll(step, step.venueId);
          if (job.status === 'running' && step.status !== 'done') await deps.sleep(POLL_MS);
          continue;
        }
        if (step.text === null) {
          step.text = tagFor(job.id, job.stepIndex, step.attempt);
          deps.jobs.write(job);
        } else if (step.name === 'Convert') {
          phase = 'lookup';
          if (step.quoteId !== null) {
            let landed = await convertLanded(step);
            if (!landed) {
              await deps.sleep(LOOKUP_RETRY_MS);
              landed = await convertLanded(step);
            }
            if (landed) continue;
          }
        } else {
          phase = 'lookup';
          let found = await lookup(step, step.text);
          if (found === null) {
            await deps.sleep(LOOKUP_RETRY_MS);
            found = await lookup(step, step.text);
          }
          if (found !== null) {
            step.venueId = found;
            deps.jobs.write(job);
            continue;
          }
        }
        phase = 'send';
        await send(step, step.text);
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
