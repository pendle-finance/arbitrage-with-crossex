import { CrossexOrderRequest, type CrossexOrder, type CrossexTransferRecord } from 'gate-api';
import type { Clients } from '../core/clients';
import { classifyGateError, refusalReason, type ClassifiedError } from '../core/errors';
import { roundToStep, stripZeros } from '../core/numbers';
import {
  arrivesFor,
  bucketsFrom,
  ceilCents,
  DUST_USDC,
  fit,
  floorCents,
  GATE_WALLET,
  HYPERLIQUID_MIN_USDC,
  MIN_TRANSFER,
  nearestCents,
  pathRule,
  SPOT_MIN_QUOTE_USDT,
  SPOT_PAIR,
  SPOT_SYMBOL,
  USDC_WALLET,
  USDT_WALLET,
  type GateAccount,
  type TransferCoin,
} from '../core/rebalance/plan';
import { decodeStatus } from '../engine/loop';
import type { TtlCache } from './cache';
import {
  HALT_TEXT,
  haltReasonFor,
  pendingStep,
  spotShortfallFailText,
  TO_USDC_STEPS,
  TO_USDT_STEPS,
  transferFailText,
  type FundsAt,
  type Job,
  type JobFile,
  type Step,
  type StepName,
  type TransferFile,
} from './rebalanceJob';

export interface RunnerDeps {
  clients: () => Clients;
  jobs: JobFile;
  cache: TtlCache;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onHalt: (job: Job) => void;
  pollOnly?: boolean;
}

export interface TransferRunnerDeps {
  clients: () => Clients;
  transfers: TransferFile;
  cache: TtlCache;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const STEP_TIMEOUT_MS = 600_000;
export const HL_TRANSFER_TIMEOUT_MS = 1_800_000;
export const POLL_MS = 1_000;
export const LOOKUP_RETRY_MS = 10_000;
export const LOOKUP_WINDOW_MS = 120_000;
export const QUOTE_FLOOR = 0.997;
export const TRANSFER_STEP = String(MIN_TRANSFER);
const CENT_STEP = '0.01';
const SWEEP_PAGE_SIZE = 100;
const SWEEP_MAX_PAGES = 50;
const SWEEP_SKEW_MS = 600_000;
const HYPERLIQUID_ACCOUNT: GateAccount = 'CROSSEX_HYPERLIQUID';
const MOVES_OUT: readonly string[] = ['To spot', 'From Hyperliquid'];
const ROUND_MOVES: readonly string[] = [...MOVES_OUT, 'To Hyperliquid'];
const ROUND_ARRIVALS: readonly string[] = ['To Gate', 'Sell USDC'];

const NOT_FOUND = /NOT_FOUND/i;
const TRANSFER_DEAD = /FAIL|CANCEL|REJECT|EXPIRE/i;

type CrossEx = Clients['crossEx'];
type Margins = { marginBalance: number; initialMargin: number };
type Sending = { cash: number; equity: number };
type WalletRef = { coin: string; venue: string };

type StepSpec =
  | { kind: 'order'; side: CrossexOrderRequest.Side; dest: FundsAt }
  | { kind: 'transfer'; coin: TransferCoin; from: GateAccount; to: GateAccount; dest: FundsAt }
  | { kind: 'convert'; dest: FundsAt };

export const STEPS: Record<StepName, StepSpec> = {
  'Buy USDC': { kind: 'order', side: CrossexOrderRequest.Side.BUY, dest: 'GATE' },
  'To spot': { kind: 'transfer', coin: 'USDC', from: 'CROSSEX_GATE', to: 'SPOT', dest: 'SPOT' },
  'To Hyperliquid': { kind: 'transfer', coin: 'USDC', from: 'SPOT', to: HYPERLIQUID_ACCOUNT, dest: 'HYPERLIQUID' },
  Convert: { kind: 'convert', dest: 'HYPERLIQUID' },
  'From Hyperliquid': { kind: 'transfer', coin: 'USDC', from: HYPERLIQUID_ACCOUNT, to: 'SPOT', dest: 'SPOT' },
  'To Gate': { kind: 'transfer', coin: 'USDC', from: 'SPOT', to: 'CROSSEX_GATE', dest: 'GATE' },
  'Sell USDC': { kind: 'order', side: CrossexOrderRequest.Side.SELL, dest: 'CROSSEX' },
};

const timeoutFor = (spec: StepSpec): number =>
  spec.kind === 'transfer' && (spec.from === HYPERLIQUID_ACCOUNT || spec.to === HYPERLIQUID_ACCOUNT)
    ? HL_TRANSFER_TIMEOUT_MS
    : STEP_TIMEOUT_MS;

export function tagFor(jobId: string, n: number, attempt = 0): string {
  return attempt > 0 ? `t-rb${jobId}${n}x${attempt}` : `t-rb${jobId}${n}`;
}

const transferAmount = (amount: number): string => stripZeros(roundToStep(amount, TRANSFER_STEP, 'down'));

export const isSendable = (amount: number): boolean => Number(transferAmount(amount)) > 0;

const isRefusal = (c: ClassifiedError): boolean =>
  Boolean(c.label) && c.httpStatus !== undefined && c.httpStatus >= 400 && c.httpStatus < 500;

const isSpotShortfall = (from: string, c: ClassifiedError): boolean =>
  from === 'SPOT' && c.label === 'TRANSFER_AMOUNT_INSUFFICIENT';

async function readAccount(
  crossEx: CrossEx,
): Promise<{ margins: Margins; cash: (wallet: WalletRef) => number; equity: (wallet: WalletRef) => number }> {
  const { body } = await crossEx.getCrossexAccount();
  const margins = { marginBalance: Number(body.marginBalance), initialMargin: Number(body.initialMargin) };
  if (!Number.isFinite(margins.marginBalance) || !Number.isFinite(margins.initialMargin)) {
    throw new Error('account read has no margin balance');
  }
  const buckets = bucketsFrom(body, [], {});
  const bucketOf = (wallet: WalletRef) =>
    buckets.find((bucket) => bucket.coin === wallet.coin && bucket.venue === wallet.venue);
  return { margins, cash: (wallet) => bucketOf(wallet)?.cash ?? 0, equity: (wallet) => bucketOf(wallet)?.equity ?? 0 };
}

export async function transferRow(
  crossEx: CrossEx,
  coin: string,
  match: (row: CrossexTransferRecord) => boolean,
): Promise<CrossexTransferRecord | null> {
  const { body } = await crossEx.listCrossexTransfers({ coin, limit: 100 });
  return (body ?? []).find(match) ?? null;
}

async function sendTransfer(
  crossEx: CrossEx,
  request: { coin: string; amount: number; from: string; to: string; text: string },
): Promise<string> {
  const { body } = await crossEx.createCrossexTransfer({
    crossexTransferRequest: { ...request, amount: transferAmount(request.amount) },
  });
  if (!body.txId) throw new Error('transfer response has no txId');
  return String(body.txId);
}

export function receivedOf(row: CrossexTransferRecord, path: { coin: string; from: string; to: string }): number {
  const actual = Number(row.actualReceive);
  if (actual > 0) return actual;
  const fee = pathRule(path.coin, path.from, path.to)?.feeUsd ?? 0;
  return Number(roundToStep(Number(row.amount) - fee, TRANSFER_STEP, 'down'));
}

async function lookUpInWindow(
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
  find: () => Promise<string | null | undefined>,
): Promise<string | null> {
  const start = clock.now();
  for (;;) {
    const found = await find();
    if (typeof found === 'string') return found;
    if (found === null && clock.now() - start >= LOOKUP_WINDOW_MS) return null;
    await clock.sleep(LOOKUP_RETRY_MS);
  }
}

export async function runJob(deps: RunnerDeps): Promise<void> {
  const job = deps.jobs.read();
  if (!job) return;
  const crossEx = () => deps.clients().crossEx;

  const halt = (reason: string): void => {
    job.status = 'halted';
    job.haltReason = reason;
    deps.jobs.write(job);
    deps.onHalt(job);
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

  const previousQty = (): number => job.steps[job.stepIndex - 1]?.qty ?? 0;

  /** Convert runs on Hyperliquid in both directions. Toward USDC it turns USDT
   * into USDC there; toward USDT it turns USDC into USDT, which lands in the
   * pooled CROSSEX bucket. */
  const convertSpec = () =>
    job.direction === 'toUsdt'
      ? { fromCoin: 'USDC', toCoin: 'USDT', dest: 'CROSSEX' as FundsAt, symbol: 'HYPERLIQUID_CONVERT_USDC_USDT' }
      : { fromCoin: 'USDT', toCoin: 'USDC', dest: 'HYPERLIQUID' as FundsAt, symbol: 'HYPERLIQUID_CONVERT_USDT_USDC' };

  const growConvert = (amount: number): void => {
    const convert = job.steps.find((step, index) => index >= job.stepIndex && step.name === 'Convert');
    if (!convert) {
      job.steps.push(pendingStep('Convert', { round: null, planned: amount, arrives: null, borrowLeft: null }));
      return;
    }
    convert.planned = nearestCents((convert.planned ?? 0) + amount);
  };

  const dropRounds = (): void => {
    const rest = job.steps.slice(job.stepIndex);
    const dropped = rest
      .filter((step) => step.round !== null && MOVES_OUT.includes(step.name))
      .reduce((total, step) => total + (step.planned ?? 0), 0);
    job.steps = [...job.steps.slice(0, job.stepIndex), ...rest.filter((step) => step.round === null)];
    growConvert(nearestCents(dropped));
    deps.jobs.write(job);
  };

  const setRoundFigures = (step: Step, size: number): void => {
    if (ROUND_MOVES.includes(step.name)) step.planned = size;
    if (ROUND_ARRIVALS.includes(step.name)) step.planned = arrivesFor(job.direction, size);
    if (step.name === 'To Hyperliquid') step.arrives = arrivesFor(job.direction, size);
  };

  const appendRound = (size: number): void => {
    const round = Math.max(0, ...job.steps.map((step) => step.round ?? 0)) + 1;
    const after = job.steps.reduce((last, step, index) => (step.round === null ? last : index + 1), 0);
    const names = job.direction === 'toUsdt' ? TO_USDT_STEPS : TO_USDC_STEPS;
    const added = names.map((name) => pendingStep(name, { round, planned: size, arrives: null, borrowLeft: null }));
    for (const step of added) setRoundFigures(step, size);
    job.steps.splice(after, 0, ...added);
  };

  const sizeRound = (step: Step, plannedMove: number, sending: Sending, margins: Margins): number | null => {
    const planned = floorCents(plannedMove);
    const size = fit(margins, Math.min(planned, sending.cash), sending.equity);
    if (size >= planned) return planned;
    const marginFit = fit(margins, planned, sending.equity);
    if (size < HYPERLIQUID_MIN_USDC) {
      if (job.route === 'mix') dropRounds();
      else halt(marginFit < HYPERLIQUID_MIN_USDC ? HALT_TEXT.marginTooLow : HALT_TEXT.cashTooLow);
      return null;
    }
    const shrink = nearestCents(planned - size);
    if (shrink >= DUST_USDC && marginFit < planned) {
      if (job.route === 'loop' && shrink >= HYPERLIQUID_MIN_USDC) appendRound(shrink);
      else growConvert(shrink);
    }
    for (const later of job.steps.slice(job.stepIndex)) {
      if (later.round === step.round) setRoundFigures(later, size);
      later.borrowLeft = null;
    }
    deps.jobs.write(job);
    return size;
  };

  const spotTicker = async (): Promise<{ ask: number; bid: number }> => {
    const { body } = await deps.clients().spot.listTickers({ currencyPair: SPOT_PAIR });
    return { ask: Number(body?.[0]?.lowestAsk), bid: Number(body?.[0]?.highestBid) };
  };

  const prepareBuy = async (step: Step): Promise<number | null> => {
    const move = job.steps.find((later, index) => index > job.stepIndex && later.name === 'To spot');
    if (!move) throw new Error('Buy USDC has no To spot step');
    const account = await readAccount(crossEx());
    const gateCash = account.cash(GATE_WALLET);
    const movable = gateCash >= DUST_USDC ? gateCash : 0;
    const sending = {
      cash: Math.max(0, account.cash(USDT_WALLET)) + movable,
      equity: Math.max(0, account.equity(USDT_WALLET)) + movable,
    };
    const size = sizeRound(step, move.planned ?? 0, sending, account.margins);
    if (size === null) return null;
    if (movable >= size) {
      finish(step, 0, 'GATE');
      return null;
    }
    const rest = size - movable;
    const { ask } = await spotTicker();
    const cost = Number.isFinite(ask) && ask > 0 ? rest * ask : rest;
    return Math.max(SPOT_MIN_QUOTE_USDT, ceilCents(cost));
  };

  const prepareToSpot = async (step: Step): Promise<number | null> => {
    const account = await readAccount(crossEx());
    const gateCash = account.cash(GATE_WALLET);
    const buy = job.steps[job.stepIndex - 1];
    const bought = buy?.name === 'Buy USDC' && buy.round === step.round && (buy.qty ?? 0) > 0;
    if (bought && gateCash < HYPERLIQUID_MIN_USDC) {
      halt(HALT_TEXT.shortBuy);
      return null;
    }
    const equity = Math.max(0, account.equity(USDT_WALLET)) + (gateCash >= DUST_USDC ? gateCash : 0);
    return sizeRound(step, step.planned ?? 0, { cash: gateCash, equity }, account.margins);
  };

  const prepareFromHyperliquid = async (step: Step): Promise<number | null> => {
    const account = await readAccount(crossEx());
    const sending = { cash: Math.max(0, account.cash(USDC_WALLET)), equity: account.equity(USDC_WALLET) };
    return sizeRound(step, step.planned ?? 0, sending, account.margins);
  };

  const prepareConvert = async (step: Step): Promise<number | null> => {
    const account = await readAccount(crossEx());
    const gateCash = account.cash(GATE_WALLET);
    if (gateCash >= DUST_USDC) {
      const { bid } = await spotTicker();
      if (gateCash * bid >= SPOT_MIN_QUOTE_USDT) {
        const planned = floorCents(gateCash);
        job.steps.splice(job.stepIndex, 0, pendingStep('Sell USDC', { round: null, planned, arrives: null, borrowLeft: null }));
        step.status = 'pending';
        step.startedAt = null;
        deps.jobs.write(job);
        return null;
      }
    }
    const sending = account.cash(job.direction === 'toUsdc' ? USDT_WALLET : USDC_WALLET);
    return floorCents(Math.min(step.planned ?? 0, Math.max(0, sending)));
  };

  const prepareSell = async (step: Step): Promise<number | null> => {
    const account = await readAccount(crossEx());
    const cash = account.cash(GATE_WALLET);
    const arrived = step.round === null ? 0 : previousQty();
    const amount = floorCents(Math.max(0, cash - arrived >= DUST_USDC ? cash : Math.min(cash, arrived)));
    const nothingToSell = (): null => {
      finish(step, 0, 'CROSSEX');
      return null;
    };
    if (amount < DUST_USDC) return nothingToSell();
    const { bid } = await spotTicker();
    const quote = Number.isFinite(bid) && bid > 0 ? amount * bid : amount;
    return quote < SPOT_MIN_QUOTE_USDT ? nothingToSell() : amount;
  };

  const prepare = (step: Step): Promise<number | null> | number => {
    switch (step.name as StepName) {
      case 'Buy USDC':
        return prepareBuy(step);
      case 'To spot':
        return prepareToSpot(step);
      case 'From Hyperliquid':
        return prepareFromHyperliquid(step);
      case 'Convert':
        return prepareConvert(step);
      case 'Sell USDC':
        return prepareSell(step);
      default:
        return previousQty();
    }
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
      return;
    }
    const row = await transferRow(crossEx(), spec.coin, (r) => String(r.id) === venueId);
    if (!row) return;
    const status = String(row.status ?? '');
    if (status === 'SUCCESS') {
      const received = receivedOf(row, spec);
      if (received > 0) finish(step, received, spec.dest);
      else halt('transfer SUCCESS with nothing received');
      return;
    }
    if (TRANSFER_DEAD.test(status)) haltDead(step, transferFailText(row.failReason ?? ''));
  };

  /** The venue id of a send whose response was lost, or null when Gate has
   * no record of it. A transfer is found by its tag; an order by its tag,
   * which Gate resolves on the order endpoint; a convert by its quote id,
   * which Gate stores as the convert order's text (checked live 2026-09-07). */
  const lookup = async (spec: StepSpec, key: string): Promise<string | null> => {
    if (spec.kind === 'transfer') {
      const row = await transferRow(crossEx(), spec.coin, (r) => r.text === key);
      return row ? String(row.id) : null;
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

  const sweep = async (spec: StepSpec, tag: string): Promise<string | null | undefined> => {
    if (spec.kind === 'transfer') return null;
    const symbol = spec.kind === 'convert' ? convertSpec().symbol : SPOT_SYMBOL;
    const idOf = (rows: CrossexOrder[]): string | null | undefined => {
      const hit = rows.find((row) => String(row.text ?? '') === tag);
      if (!hit) return null;
      return hit.orderId ? String(hit.orderId) : undefined;
    };
    try {
      const open = idOf((await crossEx().listCrossexOpenOrders({ symbol })).body ?? []);
      if (open !== null) return open;
      const from = job.createdAt - SWEEP_SKEW_MS;
      for (let page = 1; page <= SWEEP_MAX_PAGES; page += 1) {
        const rows =
          (await crossEx().listCrossexHistoryOrders({ symbol, from, limit: SWEEP_PAGE_SIZE, page })).body ?? [];
        const hit = idOf(rows);
        if (hit !== null) return hit;
        if (rows.length < SWEEP_PAGE_SIZE) return null;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  const sendConvert = async (step: Step, amount: number): Promise<void> => {
    const spec = convertSpec();
    const { body: quote } = await crossEx().createCrossexConvertQuote({
      crossexConvertQuoteRequest: {
        exchangeType: 'HYPERLIQUID',
        fromCoin: spec.fromCoin,
        toCoin: spec.toCoin,
        fromAmount: stripZeros(roundToStep(amount, CENT_STEP, 'down')),
      },
    });
    const toAmount = Number(quote.toAmount);
    if (!(toAmount >= amount * QUOTE_FLOOR)) {
      halt(HALT_TEXT.poorQuote);
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

  const send = async (step: Step, spec: StepSpec, tag: string, amount: number): Promise<void> => {
    if (spec.kind === 'convert') return sendConvert(step, amount);
    if (spec.kind === 'transfer') {
      step.venueId = await sendTransfer(crossEx(), { coin: spec.coin, amount, from: spec.from, to: spec.to, text: tag });
    } else {
      const size =
        spec.side === CrossexOrderRequest.Side.SELL
          ? { qty: roundToStep(amount, CENT_STEP, 'down') }
          : { quoteQty: stripZeros(roundToStep(amount, CENT_STEP, 'up')) };
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
        halt(HALT_TEXT.timeout);
        return;
      }
      let phase: 'poll' | 'lookup' | 'read' | 'send' = 'poll';
      let amount: number | null = null;
      try {
        if (step.venueId !== null) {
          await poll(step, spec, step.venueId);
          if (job.status === 'running' && step.status !== 'done') await deps.sleep(POLL_MS);
          continue;
        }
        const key = spec.kind === 'convert' ? step.quoteId : step.text;
        if (step.text !== null && key !== null) {
          phase = 'lookup';
          const found = (await lookUpInWindow(deps, () => lookup(spec, key))) ?? (await sweep(spec, key));
          if (found === undefined) {
            halt(HALT_TEXT.unconfirmed);
            return;
          }
          if (found !== null) {
            step.venueId = found;
            deps.jobs.write(job);
            continue;
          }
        }
        if (deps.pollOnly) {
          halt(HALT_TEXT.restart);
          return;
        }
        phase = 'read';
        amount = await prepare(step);
        if (amount === null) continue;
        if (spec.kind === 'transfer' && !isSendable(amount)) {
          halt(HALT_TEXT.cashTooLow);
          return;
        }
        if (step.text === null) {
          job.tagCount += 1;
          step.text = tagFor(job.id, job.tagCount);
          deps.jobs.write(job);
        }
        phase = 'send';
        await send(step, spec, step.text, amount);
      } catch (err) {
        const c = classifyGateError(err);
        const notFound = c.httpStatus === 404 || NOT_FOUND.test(c.label ?? '');
        if (c.retryable || (phase === 'poll' && notFound)) {
          await deps.sleep(POLL_MS);
        } else if (phase !== 'send' || isRefusal(c)) {
          if (phase === 'send') step.quoteId = null;
          halt(
            spec.kind === 'transfer' && amount !== null && isSpotShortfall(spec.from, c)
              ? spotShortfallFailText(c.message, spec.coin, amount)
              : haltReasonFor(err),
          );
        } else {
          await deps.sleep(POLL_MS);
        }
      }
    }
  } catch (err) {
    job.status = 'halted';
    job.haltReason = haltReasonFor(err);
    try {
      deps.jobs.write(job);
    } catch {}
    deps.onHalt(job);
  }
}

export async function runTransfer(deps: TransferRunnerDeps): Promise<void> {
  const transfer = deps.transfers.read();
  if (transfer?.status !== 'moving') return;
  const crossEx = () => deps.clients().crossEx;
  const find = (match: (row: CrossexTransferRecord) => boolean) => transferRow(crossEx(), transfer.coin, match);

  const accept = (venueId: string): void => {
    transfer.venueId = venueId;
    transfer.acceptedAt = deps.now();
    deps.transfers.write(transfer);
    deps.cache.bust('account');
  };

  const end = (status: 'done' | 'failed', received: number | null, failText: string | null): void => {
    Object.assign(transfer, { status, received, failText, doneAt: deps.now() });
    deps.transfers.write(transfer);
    deps.cache.bust('account');
  };

  if (transfer.venueId === null && transfer.sentAt === null) {
    if (!isSendable(transfer.amount)) {
      end('failed', null, transferFailText(''));
      return;
    }
    transfer.sentAt = deps.now();
    deps.transfers.write(transfer);
    let venueId: string | null = null;
    try {
      const { coin, amount, from, to, text } = transfer;
      venueId = await sendTransfer(crossEx(), { coin, amount, from, to, text });
    } catch (err) {
      const classified = classifyGateError(err);
      if (isRefusal(classified)) {
        if (isSpotShortfall(transfer.from, classified)) {
          end('failed', null, spotShortfallFailText(classified.message, transfer.coin, transfer.amount));
          return;
        }
        const reason = haltReasonFor(err);
        end('failed', null, reason === HALT_TEXT.marginRefused ? reason : transferFailText(refusalReason(err)));
        return;
      }
    }
    if (venueId !== null) accept(venueId);
  }

  if (transfer.venueId === null) {
    const found = await lookUpInWindow(deps, () =>
      find((row) => row.text === transfer.text).then(
        (row) => (row ? String(row.id) : null),
        () => undefined,
      ),
    );
    if (found === null) {
      end('failed', null, HALT_TEXT.noRecord);
      return;
    }
    accept(found);
  }

  const venueId = transfer.venueId;
  for (;;) {
    const row = await find((r) => String(r.id) === venueId).catch(() => null);
    const status = String(row?.status ?? '');
    if (row && status === 'SUCCESS') {
      end('done', receivedOf(row, transfer), null);
      return;
    }
    if (row && TRANSFER_DEAD.test(status)) {
      end('failed', null, transferFailText(row.failReason ?? ''));
      return;
    }
    await deps.sleep(POLL_MS);
  }
}
