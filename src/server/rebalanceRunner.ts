import { CrossexOrderRequest, type CrossexTransferRecord } from 'gate-api';
import type { Clients } from '../core/clients';
import { classifyGateError } from '../core/errors';
import { roundToStep } from '../core/numbers';
import { SPOT_SYMBOL } from '../core/rebalance/plan';
import type { TtlCache } from './cache';
import type { FundsAt, JobFile, Step } from './rebalanceJob';

export interface RunnerDeps {
  clients: () => Clients;
  jobs: JobFile;
  cache: TtlCache;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const STEP_TIMEOUT_MS = 600_000;
export const POLL_MS = 1_000;
export const LOOKUP_RETRY_MS = 10_000;
export const QUOTE_FLOOR = 0.997;
export const TRANSFER_STEP = '0.00001';

const OPEN_STATE = /OPEN|NEW|PENDING|PARTIAL/i;
const NOT_FOUND = /NOT_FOUND/i;

export function tagFor(jobId: string, stepIndex: number): string {
  return `t-rb${jobId}${stepIndex}`;
}

export async function runJob(deps: RunnerDeps): Promise<void> {
  const job = deps.jobs.read();
  if (!job) return;
  const crossEx = () => deps.clients().crossEx;

  const halt = (reason: string): void => {
    job.status = 'halted';
    job.haltReason = reason;
    deps.jobs.write(job);
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
    const { body } = await crossEx().listCrossexTransfers({ coin: 'USDC', limit: 20 });
    return (body ?? []).find(match) ?? null;
  };

  const poll = async (step: Step, venueId: string): Promise<void> => {
    if (step.name === 'Buy USDC') {
      const { body } = await crossEx().getCrossexOrder(venueId);
      const state = String(body.state ?? '');
      if (OPEN_STATE.test(state)) return;
      const filled = Number(body.executedQty ?? 0);
      if (filled > 0) finish(step, filled, 'GATE');
      else halt(`order ${state} with nothing filled`);
      return;
    }
    const row = await transferRow((r) => r.id === venueId);
    if (!row) return;
    if (row.status === 'SUCCESS') {
      finish(step, Number(row.actualReceive ?? row.amount), step.name === 'To spot' ? 'SPOT' : 'HYPERLIQUID');
    } else if (row.status === 'FAILED') {
      halt(row.failReason || 'transfer FAILED');
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

  const convertLanded = async (step: Step): Promise<boolean> => {
    const balance = await usdcOnHyperliquid();
    if (step.balanceBefore === null || step.qty === null || balance - step.balanceBefore < step.qty - 0.01) {
      return false;
    }
    finish(step, step.qty, 'HYPERLIQUID');
    return true;
  };

  const transfer = async (from: string, to: string, tag: string): Promise<string> => {
    const amount = job.steps[job.stepIndex - 1].qty ?? 0;
    const { body } = await crossEx().createCrossexTransfer({
      crossexTransferRequest: { coin: 'USDC', amount: roundToStep(amount, TRANSFER_STEP, 'down'), from, to, text: tag },
    });
    return String(body.txId);
  };

  const sendConvert = async (step: Step): Promise<void> => {
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
    const balanceBefore = await usdcOnHyperliquid();
    step.quoteId = String(quote.quoteId);
    step.qty = toAmount;
    step.balanceBefore = balanceBefore;
    deps.jobs.write(job);
    const { body } = await crossEx().createCrossexConvertOrder({
      crossexConvertOrderRequest: { quoteId: step.quoteId },
    });
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
      step.venueId = String(body.orderId);
    } else if (step.name === 'To spot') {
      step.venueId = await transfer('CROSSEX_GATE', 'SPOT', tag);
    } else {
      step.venueId = await transfer('SPOT', 'CROSSEX_HYPERLIQUID', tag);
    }
    deps.jobs.write(job);
  };

  try {
    while (job.status === 'running') {
      const step = job.steps[job.stepIndex];
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
          step.text = tagFor(job.id, job.stepIndex);
          deps.jobs.write(job);
        } else if (step.name === 'Convert') {
          phase = 'lookup';
          if (step.quoteId !== null && (await convertLanded(step))) continue;
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
        if (c.retryable) {
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
    } catch {
      return;
    }
  }
}
