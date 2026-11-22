import { CrossexOrderRequest, type CrossexOrder, type CrossexTransferRecord } from 'gate-api';
import type { Clients } from '../core/clients';
import { classifyGateError, CoreError, refusalReason, type ClassifiedError } from '../core/errors';
import { DEFAULT_STEP, floorDecimalString, floorToStep, formatRestPrice, parseSymbol, roundToStep, stripZeros } from '../core/numbers';
import { fetchDeepBook, touchOf, type NormalizedBook } from '../core/estimate/books';
import { sliceQtys } from '../core/rebalance/slices';
import { clipBandPrice } from '../engine/decide';
import { BOROS_CLOSE_FALLBACK_SLIPPAGE_PCT, closeBorosLegs, type BorosCloseDeps } from './borosClose';
import {
  arrivesFor,
  bookLevels,
  bucketsFrom,
  buyableUsdc,
  buyCostUsdt,
  ceilCents,
  CONVERT_MAX,
  CONVERT_RATE,
  DUST_USDC,
  fit,
  floorCents,
  GATE_WALLET,
  HYPERLIQUID_MIN_USDC,
  imUsedOf,
  MIN_TRANSFER,
  nearestCents,
  pathRule,
  poolWallet,
  priceOrOne,
  roundMinimum,
  spotArrivalFor,
  SPOT_MIN_QUOTE_USDT,
  SPOT_PAIR,
  SPOT_SYMBOL,
  spotOrderMax,
  USDT_WALLET,
  CONVERT_TO,
  type GateAccount,
  type SpotDepth,
  type TransferCoin,
} from '../core/rebalance/plan';
import { marginPerConvertUsdc, minQtyOf, positiveOf, type PerpRule } from '../core/rebalance/realize';
import { decodeStatus } from '../engine/loop';
import { TTL, type TtlCache } from './cache';
import {
  ADD_BACK_FIRST,
  addBackPartText,
  addBackRowsOf,
  asRealize,
  BOROS_STEP,
  borosPartText,
  borosWaitText,
  FIX_UNCONFIRMED,
  FOLLOW_MISSES_RED,
  MAKER_REPEG_MS,
  MAKER_REST_MS,
  RETRY_CONVERT_CAP,
  SLICE_STEP,
  SLIPPAGE_BAND_BP,
  type AddBack,
  type FixAction,
  type PerpOrder,
  convertSteps,
  HALT_TEXT,
  hedgesOf,
  haltReasonFor,
  pendingStep,
  REOPEN_HALT,
  roundStepNames,
  spotShortfallFailText,
  TO_VENUE_STEP,
  transferFailText,
  type FundsAt,
  type HaltKind,
  type ImUsedRow,
  type Job,
  type JobFile,
  type RealizeJobLeg,
  type Step,
  type StepName,
  type StepPerp,
  type StepRetry,
  type TransferFile,
} from './rebalanceJob';

export interface RunnerDeps {
  clients: () => Clients;
  jobs: JobFile;
  cache: TtlCache;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onHalt: (job: Job) => void;
  onDone?: () => void;
  pollOnly?: boolean;
  book?: (symbol: string) => Promise<NormalizedBook | null>;
  boros?: BorosRunnerDeps;
  takeFix?: () => QueuedFix | null;
}

export interface QueuedFix {
  action: FixAction;
  done: (job: Job) => void;
  fail: (err: unknown) => void;
}

export interface BorosRunnerDeps {
  deps: BorosCloseDeps;
  address: string;
  slippagePct?: (marketId: number) => Promise<number | null>;
}

export interface TransferRunnerDeps {
  clients: () => Clients;
  transfers: TransferFile;
  cache: TtlCache;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onDone?: () => void;
}

export const STEP_TIMEOUT_MS = 600_000;
export const HL_TRANSFER_TIMEOUT_MS = 1_800_000;
export const POLL_MS = 1_000;
export const BALANCE_LAG_MS = 120_000;
export const LOOKUP_RETRY_MS = 10_000;
export const LOOKUP_WINDOW_MS = 120_000;
export const QUOTE_FLOOR = 0.997;
/** Gate's CrossEx API doc caps Convert orders at 10 requests per 10 s, and run 26 saw
 * the 11th Convert order refused within about 6 s. 2 s between Convert quotes keeps a
 * run at 5 orders per 10 s. The same doc caps Convert quotes at 100 per day. */
export const CONVERT_GAP_MS = 2_000;
export const TRANSFER_STEP = String(MIN_TRANSFER);
const CENT_STEP = '0.01';
const SWEEP_PAGE_SIZE = 100;
const SWEEP_MAX_PAGES = 50;
const SWEEP_SKEW_MS = 600_000;
const HYPERLIQUID_ACCOUNT: GateAccount = 'CROSSEX_HYPERLIQUID';
const LIGHTER_ACCOUNT: GateAccount = 'CROSSEX_LIGHTER';
const MOVES_OUT: readonly string[] = ['To spot', 'From Hyperliquid', 'From Lighter'];
const ROUND_ARRIVALS: readonly string[] = ['To Gate', 'Sell USDC'];
const INTO_VENUE: readonly string[] = Object.values(TO_VENUE_STEP);
export const REOPEN_FIRST_WAIT_MS = 2_000;
export const REOPEN_MAX_WAIT_MS = 60_000;
const RATE_LIMIT_HALT_AFTER = 10;
const RETRY_CONVERT_HEADROOM = 1.05;
const DELIST_LABEL = 'TRADE_DELIST_OPEN_PROHIBITED_ERROR';
const ORDER_ALLOWANCE_LABELS: readonly string[] = ['TRADE_HYPERLIQUID_ORDER_LIMIT_ERROR', 'TRADE_LIGHTER_ORDER_LIMIT_ERROR'];

const lotsOf = (qty: number, lot: string): number => Math.round(qty / Number(lot));

const NOT_FOUND = /NOT_FOUND/i;
const TRANSFER_DEAD = /FAIL|CANCEL|REJECT|EXPIRE/i;

type CrossEx = Clients['crossEx'];
type Margins = { marginBalance: number; initialMargin: number };
type Sending = { cash: number; equity: number };
type WalletRef = { coin: string; venue: string };
type AskDepth = Pick<SpotDepth, 'ask' | 'asks'>;

type StepSpec =
  | { kind: 'order'; side: CrossexOrderRequest.Side; dest: FundsAt }
  | { kind: 'transfer'; coin: TransferCoin; from: GateAccount; to: GateAccount; dest: FundsAt }
  | { kind: 'convert'; dest: FundsAt }
  | { kind: 'perp' }
  | { kind: 'boros' };

type MoneySpec = Exclude<StepSpec, { kind: 'perp' } | { kind: 'boros' }>;

export interface SpotTicker {
  ask: number;
  bid: number;
}

export async function readSpotTicker(clients: Pick<Clients, 'spot'>): Promise<SpotTicker> {
  const { body } = await clients.spot.listTickers({ currencyPair: SPOT_PAIR });
  return { ask: Number(body?.[0]?.lowestAsk), bid: Number(body?.[0]?.highestBid) };
}

export const quoteFloor = (amount: number, gives: TransferCoin, ticker: SpotTicker | null): number =>
  (gives === 'USDC' ? amount / priceOrOne(ticker?.ask) : amount * priceOrOne(ticker?.bid)) * QUOTE_FLOOR;

export const STEPS: Record<StepName, StepSpec> = {
  'Buy USDC': { kind: 'order', side: CrossexOrderRequest.Side.BUY, dest: 'GATE' },
  'To spot': { kind: 'transfer', coin: 'USDC', from: 'CROSSEX_GATE', to: 'SPOT', dest: 'SPOT' },
  'To Hyperliquid': { kind: 'transfer', coin: 'USDC', from: 'SPOT', to: HYPERLIQUID_ACCOUNT, dest: 'HYPERLIQUID' },
  'To Lighter': { kind: 'transfer', coin: 'USDC', from: 'SPOT', to: LIGHTER_ACCOUNT, dest: 'LIGHTER' },
  Convert: { kind: 'convert', dest: 'HYPERLIQUID' },
  'Convert to USDT': { kind: 'convert', dest: 'CROSSEX' },
  'Convert to USDC': { kind: 'convert', dest: 'HYPERLIQUID' },
  'From Hyperliquid': { kind: 'transfer', coin: 'USDC', from: HYPERLIQUID_ACCOUNT, to: 'SPOT', dest: 'SPOT' },
  'From Lighter': { kind: 'transfer', coin: 'USDC', from: LIGHTER_ACCOUNT, to: 'SPOT', dest: 'SPOT' },
  'To Gate': { kind: 'transfer', coin: 'USDC', from: 'SPOT', to: 'CROSSEX_GATE', dest: 'GATE' },
  'Sell USDC': { kind: 'order', side: CrossexOrderRequest.Side.SELL, dest: 'CROSSEX' },
  Close: { kind: 'perp' },
  Reopen: { kind: 'perp' },
  [SLICE_STEP]: { kind: 'perp' },
  [BOROS_STEP]: { kind: 'boros' },
};

const SLOW_ACCOUNTS: readonly GateAccount[] = [HYPERLIQUID_ACCOUNT, LIGHTER_ACCOUNT];

const timeoutFor = (spec: StepSpec): number =>
  spec.kind === 'transfer' && (SLOW_ACCOUNTS.includes(spec.from) || SLOW_ACCOUNTS.includes(spec.to))
    ? HL_TRANSFER_TIMEOUT_MS
    : STEP_TIMEOUT_MS;

export function tagFor(jobId: string, n: number, attempt = 0): string {
  return attempt > 0 ? `t-rb${jobId}${n}x${attempt}` : `t-rb${jobId}${n}`;
}

const transferAmount = (amount: number): string => stripZeros(floorToStep(amount, TRANSFER_STEP));

export const isSendable = (amount: number): boolean => Number(transferAmount(amount)) > 0;

const capToBalance = (wanted: number, balance: number): number =>
  Math.min(floorCents(Math.max(0, wanted)), Number(floorToStep(Math.max(0, balance), CENT_STEP)));

const isRefusal = (c: ClassifiedError): boolean =>
  Boolean(c.label) && c.httpStatus !== undefined && c.httpStatus >= 400 && c.httpStatus < 500;

const isSpotShortfall = (from: string, c: ClassifiedError): boolean =>
  from === 'SPOT' && c.label === 'TRANSFER_AMOUNT_INSUFFICIENT';

async function readAccount(
  crossEx: CrossEx,
): Promise<{
  margins: Margins;
  available: number;
  cash: (wallet: WalletRef) => number;
  equity: (wallet: WalletRef) => number;
  borrow: (wallet: WalletRef) => number | null;
}> {
  const { body } = await crossEx.getCrossexAccount();
  const margins = { marginBalance: Number(body.marginBalance), initialMargin: Number(body.initialMargin) };
  const available = Number(body.availableMargin);
  if (!Number.isFinite(margins.marginBalance) || !Number.isFinite(margins.initialMargin)) {
    throw new Error('account read has no margin balance');
  }
  const buckets = bucketsFrom(body, [], {});
  const bucketOf = (wallet: WalletRef) =>
    buckets.find((bucket) => bucket.coin === wallet.coin && bucket.venue === wallet.venue);
  const cash = (wallet: WalletRef): number => {
    const raw = body.assets?.find((asset) => asset.coin === wallet.coin && asset.exchangeType === wallet.venue)?.balance;
    const floored = Number(floorDecimalString(raw ?? '', TRANSFER_STEP));
    return Number.isFinite(floored) ? floored : 0;
  };
  return {
    margins,
    available: Number.isFinite(available) ? available : 0,
    cash,
    equity: (wallet) => bucketOf(wallet)?.equity ?? 0,
    borrow: (wallet) => {
      const raw = body.assets?.find((asset) => asset.coin === wallet.coin && asset.exchangeType === wallet.venue)?.liability;
      if (raw === undefined || raw === null || raw === '') return null;
      const liability = Math.abs(Number(raw));
      return Number.isFinite(liability) ? liability : null;
    },
  };
}

type OrderMode = { kind: 'market' } | { kind: 'ioc'; price: string } | { kind: 'poc'; price: string };
type SliceRule = { lot: string; tick: string; limits: PerpRule & { maxMarketSize?: string } };

const QTY_SCALE = 1e8;
const addQty = (a: number, b: number): number => Math.round((a + b) * QTY_SCALE) / QTY_SCALE;
const qtyText = (lots: number, lot: string): string => stripZeros(roundToStep(lots * Number(lot), lot, 'nearest'));
const POC_REJECT = /POC|POST_ONLY/i;

async function placePerp(crossEx: CrossEx, perp: StepPerp, tag: string, qty: string, mode: OrderMode): Promise<string> {
  const { body } = await crossEx.createCrossexOrder({
    crossexOrderRequest: {
      symbol: perp.symbol,
      side: perp.side === 'BUY' ? CrossexOrderRequest.Side.BUY : CrossexOrderRequest.Side.SELL,
      type: mode.kind === 'market' ? CrossexOrderRequest.Type.MARKET : CrossexOrderRequest.Type.LIMIT,
      timeInForce: mode.kind === 'poc' ? CrossexOrderRequest.TimeInForce.POC : CrossexOrderRequest.TimeInForce.IOC,
      qty,
      ...(mode.kind === 'market' ? {} : { price: mode.price }),
      text: tag,
      ...(perp.reduceOnly ? { reduceOnly: CrossexOrderRequest.ReduceOnly.True } : {}),
    },
  });
  if (!body.orderId) throw new Error('order response has no orderId');
  return String(body.orderId);
}

async function readOrder(crossEx: CrossEx, key: string): Promise<CrossexOrder | null> {
  try {
    return (await crossEx.getCrossexOrder(key)).body;
  } catch (err) {
    const c = classifyGateError(err);
    if (c.httpStatus === 404 || NOT_FOUND.test(c.label ?? '')) return null;
    throw err;
  }
}

async function sliceRule(deps: RunnerDeps, symbol: string): Promise<SliceRule> {
  const { value: rules } = await deps.cache.get('rules:all', TTL.static, async () => (await deps.clients().crossEx.listCrossexRuleSymbols()).body);
  const rule = rules?.find((candidate) => candidate.symbol === symbol);
  if (!rule || !(positiveOf(rule.lotSize) > 0)) throw new Error(`Gate has no order rules for ${symbol}`);
  return { lot: rule.lotSize, tick: positiveOf(rule.tickSize) > 0 ? rule.tickSize : DEFAULT_STEP, limits: rule };
}

async function bookOf(deps: RunnerDeps, symbol: string): Promise<NormalizedBook | null> {
  if (deps.book) return deps.book(symbol);
  const { exchange, base, quote } = parseSymbol(symbol);
  return fetchDeepBook(exchange, base, quote);
}

async function priceFor(deps: RunnerDeps, perp: StepPerp, rule: SliceRule, rest: boolean): Promise<{ price: string; mid: number } | null> {
  const touch = touchOf(await bookOf(deps, perp.symbol).catch(() => null));
  if (!touch || !(touch.mid > 0)) return null;
  if (rest) {
    const at = perp.side === 'BUY' ? touch.bestBid : touch.bestAsk;
    return { price: formatRestPrice(at, perp.side, perp.symbol, rule.tick), mid: touch.mid };
  }
  const leg = { contract: perp.symbol, side: perp.side, lot: rule.lot, minSize: '0', minNotional: '0', tick: rule.tick };
  return { price: clipBandPrice(String(touch.mid), leg, SLIPPAGE_BAND_BP), mid: touch.mid };
}

function costOrder(job: Job, order: PerpOrder, body: CrossexOrder, leg?: RealizeJobLeg): void {
  const fee = Math.abs(Number(body.fee));
  const paid = Number.isFinite(fee) ? fee : 0;
  job.feeSoFarUsd = nearestCents(job.feeSoFarUsd + paid);
  const avg = positiveOf(String(body.executedAvgPrice ?? ''));
  const mid = order.mid ?? 0;
  const worse = order.side === 'BUY' ? avg - mid : mid - avg;
  const impact = order.side && avg > 0 && mid > 0 ? order.credited * Math.max(0, worse) : 0;
  job.totalCostUsd = nearestCents((job.totalCostUsd ?? 0) + paid + impact);
  const entry = order.entry ?? 0;
  if (leg && avg > 0 && entry > 0) leg.realizedUsd = nearestCents(leg.realizedUsd + order.credited * (leg.side === 'SHORT' ? entry - avg : avg - entry));
}

function creditOrder(job: Job, order: PerpOrder, body: CrossexOrder, leg?: RealizeJobLeg): { delta: number; closed: boolean } {
  const executed = positiveOf(String(body.executedQty ?? ''));
  const delta = Math.max(0, addQty(executed, -order.credited));
  order.credited = Math.max(order.credited, executed);
  const closed = decodeStatus(String(body.state ?? '')) === 'closed';
  if (closed) costOrder(job, order, body, leg);
  return { delta, closed };
}

async function readImUsed(deps: RunnerDeps): Promise<ImUsedRow[] | null> {
  const read = async () => (await deps.clients().crossEx.getCrossexAccount()).body;
  const { value } = await deps.cache.get('account', TTL.live, read, { fresh: true }).catch(() => ({ value: null }));
  return value ? imUsedOf(value) : null;
}

async function endJob(deps: RunnerDeps, job: Job): Promise<void> {
  job.status = 'done';
  job.haltReason = null;
  job.haltKind = null;
  if (job.kind === 'delever') job.imUsedEnd = (await readImUsed(deps)) ?? job.imUsedEnd;
}

const legFor = (job: Job, step: Step | undefined): RealizeJobLeg | undefined =>
  job.realize?.legs.find((leg) => leg.symbol === step?.perp?.symbol);

const openFollowOf = (leg: RealizeJobLeg, step: Step): number => Math.max(0, addQty(leg.filledQty, -(step.qty ?? 0)));

function syncFollow(job: Job, step: Step, leg: RealizeJobLeg): void {
  const open = openFollowOf(leg, step);
  job.notHedgedQty = open;
  job.follow = open > 0 && step.follow ? { ...step.follow, qty: open } : null;
}

function borosTargets(job: Job): { row: NonNullable<Job['delever']>['boros'][number]; target: number }[] {
  const leg = job.realize?.legs[0];
  if (!job.delever || !leg || !(leg.positionQty > 0)) return [];
  const share = leg.filledQty / leg.positionQty;
  return job.delever.boros.map((row) => ({
    row,
    target: Math.min(Math.abs(row.before - row.after), Math.abs(row.before) * share),
  }));
}

function setBorosGap(job: Job): void {
  if (!job.delever) return;
  job.borosGapYu = borosTargets(job).reduce((total, { row, target }) => total + Math.max(0, target - row.closed), 0);
}

const BOROS_MISSING_TEXT = 'The app has no Boros wallet to close the Boros share with.';
const BOROS_DUST_YU = 1e-9;
export const BOROS_LATE_SEND_MS = 10 * 60_000;

class BorosWaitError extends CoreError {}

async function closeBorosRest(deps: RunnerDeps, job: Job): Promise<number> {
  try {
    for (const { row, target } of borosTargets(job)) {
      const rest = target - row.closed;
      if (!(rest > BOROS_DUST_YU)) continue;
      const boros = deps.boros;
      if (!boros) throw new Error(BOROS_MISSING_TEXT);
      const waitMs = row.sent ? row.sent.sentAt + BOROS_LATE_SEND_MS - deps.now() : 0;
      if (waitMs > 0) throw new BorosWaitError(borosWaitText(waitMs), 'validation');
      row.sent = null;
      job.tagCount += 1;
      const clientOrderId = tagFor(job.id, job.tagCount);
      deps.jobs.write(job);
      const slippagePct = (await boros.slippagePct?.(row.marketId).catch(() => null)) ?? BOROS_CLOSE_FALLBACK_SLIPPAGE_PCT;
      const keep = Math.max(0, Math.abs(row.before) - target);
      const onSend = (): void => {
        row.sent = { tag: clientOrderId, size: rest, sentAt: deps.now() };
        deps.jobs.write(job);
      };
      const result = await closeBorosLegs(boros.deps, { address: boros.address, legs: [{ marketId: row.marketId, size: rest, keep }], slippagePct, clientOrderId, onSend });
      row.sent = null;
      const held = result.held.find((leg) => leg.marketId === row.marketId)?.size;
      const goneBefore = held === undefined ? row.closed : Math.max(row.closed, Math.abs(row.before) - held);
      const filled = result.filled.find((leg) => leg.marketId === row.marketId)?.size ?? 0;
      row.closed = Math.min(target, goneBefore + filled);
      deps.jobs.write(job);
    }
  } finally {
    job.borosLeftYu = borosTargets(job).reduce((total, { row, target }) => total + Math.max(0, target - row.closed), 0);
    if (job.borosLeftYu <= BOROS_DUST_YU) job.borosLeftYu = 0;
    setBorosGap(job);
    deps.jobs.write(job);
  }
  return job.borosLeftYu;
}

export async function cancelRestingLead(deps: RunnerDeps, job: Job): Promise<void> {
  const step = job.steps[job.stepIndex];
  const leg = legFor(job, step);
  const order = step?.name === SLICE_STEP ? step.lead : null;
  if (step && leg && order) {
    const crossEx = deps.clients().crossEx;
    try {
      const id = order.venueId ?? (await readOrder(crossEx, order.text))?.orderId ?? null;
      if (id === null || id === undefined) step.lead = null;
      else {
        order.venueId = String(id);
        await crossEx.cancelCrossexOrder(order.venueId).catch(() => undefined);
        const body = await readOrder(crossEx, order.venueId);
        if (body) {
          const { delta, closed } = creditOrder(job, order, body, leg);
          leg.filledQty = addQty(leg.filledQty, delta);
          if (closed) step.lead = null;
        }
      }
    } catch {}
  }
  if (step && leg) syncFollow(job, step, leg);
  const sliceDone = !step?.lead && job.notHedgedQty === 0;
  job.status = 'halted';
  job.paused = job.pauseRequested && sliceDone;
  if (job.paused) job.pauseRequested = false;
  job.haltReason = job.paused ? null : HALT_TEXT.restart;
  job.haltKind = job.paused ? null : 'restart';
  setBorosGap(job);
  deps.jobs.write(job);
}

const MARKET_FIX_WAIT_MS = STEP_TIMEOUT_MS;

async function addBackLeg(
  deps: RunnerDeps,
  job: Job,
  perp: NonNullable<Job['delever']>['legs'][number],
  row: AddBack['legs'][number],
  qty: number,
): Promise<void> {
  const crossEx = deps.clients().crossEx;
  const rule = await sliceRule(deps, perp.symbol);
  const lot = Number(rule.lot);
  const wantLots = Math.floor(qty / lot + 1e-9);
  const max = positiveOf(rule.limits.maxMarketSize);
  const maxLots = max > 0 ? Math.max(1, Math.floor(max / lot + 1e-9)) : Number.POSITIVE_INFINITY;
  const side = perp.side === 'SHORT' ? 'SELL' : 'BUY';
  const target: StepPerp = { symbol: perp.symbol, exchange: perp.exchange, side, reduceOnly: false };
  for (;;) {
    const order = row.order;
    if (order) {
      const body = await readOrder(crossEx, order.venueId ?? order.text);
      if (!body) {
        if (order.venueId !== null || deps.now() - order.sentAt < LOOKUP_WINDOW_MS) throw new Error(FIX_UNCONFIRMED);
        row.order = null;
      } else {
        order.venueId = order.venueId ?? (body.orderId ? String(body.orderId) : null);
        const { delta, closed } = creditOrder(job, order, body);
        row.filled = addQty(row.filled, delta);
        deps.jobs.write(job);
        if (!closed) {
          if (deps.now() - order.sentAt > MARKET_FIX_WAIT_MS) throw new Error(FIX_UNCONFIRMED);
          await deps.sleep(POLL_MS);
          continue;
        }
        row.order = null;
        deps.jobs.write(job);
        if (order.credited === 0) throw new Error(String(body.reason ?? '') || `Gate filled none of the ${perp.base} order. Try again.`);
      }
    }
    const leftLots = wantLots - lotsOf(row.filled, rule.lot);
    if (leftLots <= 0) return;
    job.tagCount += 1;
    const sent: PerpOrder = { text: tagFor(job.id, job.tagCount), venueId: null, sentAt: deps.now(), credited: 0, poc: false, price: null, side, mid: null };
    row.order = sent;
    deps.jobs.write(job);
    try {
      sent.venueId = await placePerp(crossEx, target, sent.text, qtyText(Math.min(leftLots, maxLots), rule.lot), { kind: 'market' });
    } catch (err) {
      if (isRefusal(classifyGateError(err))) row.order = null;
      deps.jobs.write(job);
      throw err;
    }
    deps.jobs.write(job);
  }
}

export async function settleAddBack(deps: RunnerDeps, job: Job): Promise<string[]> {
  const unread: string[] = [];
  for (const row of job.steps[job.stepIndex]?.addBack?.legs ?? []) {
    const order = row.order;
    if (!order) continue;
    const body = await readOrder(deps.clients().crossEx, order.venueId ?? order.text);
    if (!body) {
      if (deps.now() - order.sentAt < LOOKUP_WINDOW_MS) throw new CoreError(FIX_UNCONFIRMED, 'validation');
      if (order.venueId !== null) unread.push(row.symbol);
    } else {
      order.venueId = order.venueId ?? (body.orderId ? String(body.orderId) : null);
      const { delta, closed } = creditOrder(job, order, body);
      row.filled = addQty(row.filled, delta);
      deps.jobs.write(job);
      if (!closed) throw new CoreError(FIX_UNCONFIRMED, 'validation');
    }
    row.order = null;
    deps.jobs.write(job);
  }
  return unread;
}

export async function applyFix(deps: RunnerDeps, job: Job, action: FixAction): Promise<Job> {
  const step = job.steps[job.stepIndex];
  const crossEx = deps.clients().crossEx;
  if (action === 'boros-retry') {
    if (step?.addBack && job.status === 'halted') throw new CoreError(ADD_BACK_FIRST, 'validation');
    if (job.delever && (job.status === 'abandoned' || step?.name === SLICE_STEP)) {
      await closeBorosRest(deps, job);
      deps.jobs.write(job);
      return job;
    }
    if (step?.name !== BOROS_STEP) return job;
    const left = await closeBorosRest(deps, job);
    if (left > 0) {
      job.haltReason = borosPartText(left);
      job.haltKind = 'boros';
    } else {
      step.status = 'done';
      step.doneAt = deps.now();
      if (job.stepIndex === job.steps.length - 1) await endJob(deps, job);
      else {
        job.stepIndex += 1;
        job.status = 'running';
        job.haltReason = null;
        job.haltKind = null;
      }
    }
    deps.jobs.write(job);
    return job;
  }
  if (action === 'add-back') {
    const lead = job.realize?.legs[0];
    const total = borosTargets(job).reduce((sum, { target }) => sum + target, 0);
    const perps = job.delever?.legs ?? [];
    if (step?.name !== BOROS_STEP || !lead || !(total > 0) || perps.length < 2) return job;
    if (!step.addBack && !(job.borosLeftYu > 0)) return job;
    const plan = (step.addBack ??= { qty: (lead.filledQty * job.borosLeftYu) / total, legs: perps.map((perp) => ({ symbol: perp.symbol, filled: 0, order: null })) });
    try {
      for (const perp of perps) {
        const row = plan.legs.find((candidate) => candidate.symbol === perp.symbol);
        if (row) await addBackLeg(deps, job, perp, row, plan.qty);
      }
    } catch (err) {
      const rows = addBackRowsOf(job);
      if (rows.some((row) => row.filled > 0)) {
        job.haltReason = addBackPartText(rows);
        deps.jobs.write(job);
      } else if (plan.legs.every((row) => row.filled === 0 && row.order === null)) {
        step.addBack = null;
        deps.jobs.write(job);
      }
      throw err;
    }
    job.borosLeftYu = 0;
    job.borosGapYu = 0;
    step.status = 'done';
    step.doneAt = deps.now();
    await endJob(deps, job);
    deps.jobs.write(job);
    return job;
  }
  const leg = legFor(job, step);
  const follow = step?.follow;
  if (!step || !leg || !follow || step.name !== SLICE_STEP) return job;
  const pending = step.hedge;
  if (pending) {
    const body = await readOrder(crossEx, pending.venueId ?? pending.text);
    if (!body && (pending.venueId !== null || deps.now() - pending.sentAt < LOOKUP_WINDOW_MS)) throw new Error(FIX_UNCONFIRMED);
    if (body) {
      pending.venueId = pending.venueId ?? (body.orderId ? String(body.orderId) : null);
      const credit = creditOrder(job, pending, body);
      step.qty = addQty(step.qty ?? 0, credit.delta);
      deps.jobs.write(job);
      if (!credit.closed) throw new Error(FIX_UNCONFIRMED);
      if (pending.credited > 0) job.followMisses = 0;
    }
    step.hedge = null;
    syncFollow(job, step, leg);
    deps.jobs.write(job);
  }
  const rule = await sliceRule(deps, follow.symbol);
  const lots = lotsOf(openFollowOf(leg, step), rule.lot);
  if (lots <= 0) return job;
  const priced = await priceFor(deps, follow, rule, false);
  let mode: OrderMode = { kind: 'market' };
  if (action === 'limit') {
    if (!priced) throw new Error(`No order book for ${follow.symbol}. Try again.`);
    mode = { kind: 'ioc', price: priced.price };
  }
  job.tagCount += 1;
  const order: PerpOrder = {
    text: tagFor(job.id, job.tagCount),
    venueId: null,
    sentAt: deps.now(),
    credited: 0,
    poc: false,
    price: mode.kind === 'market' ? null : mode.price,
    side: follow.side,
    mid: priced?.mid ?? null,
  };
  step.hedge = order;
  deps.jobs.write(job);
  try {
    order.venueId = await placePerp(crossEx, follow, order.text, qtyText(lots, rule.lot), mode);
  } catch (err) {
    if (isRefusal(classifyGateError(err))) step.hedge = null;
    deps.jobs.write(job);
    throw err;
  }
  deps.jobs.write(job);
  const start = deps.now();
  for (;;) {
    const body = await readOrder(crossEx, order.venueId);
    const credit = body ? creditOrder(job, order, body) : { delta: 0, closed: false };
    step.qty = addQty(step.qty ?? 0, credit.delta);
    if (credit.closed || deps.now() - start > MARKET_FIX_WAIT_MS) break;
    await deps.sleep(POLL_MS);
  }
  if (step.hedge?.credited === order.credited) step.hedge = null;
  if (order.credited > 0) job.followMisses = 0;
  step.attempt = 0;
  step.nextTryAt = null;
  syncFollow(job, step, leg);
  job.status = 'running';
  job.haltReason = null;
  job.haltKind = null;
  deps.jobs.write(job);
  return job;
}

type Account = Awaited<ReturnType<typeof readAccount>>;

function errorFromReason(reason: string): unknown {
  let label: string | undefined;
  try {
    label = (JSON.parse(reason) as { label?: string }).label;
  } catch {
    label =
      reason.match(/label:\s*([A-Z0-9_]+)/i)?.[1] ??
      reason.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0] ??
      (/insufficient|margin/i.test(reason) ? 'INSUFFICIENT_MARGIN' : undefined);
  }
  return { response: { status: 400, data: { label, message: reason } } };
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
  const actual = Number(floorDecimalString(String(row.actualReceive ?? ''), TRANSFER_STEP));
  if (actual > 0) return actual;
  const fee = pathRule(path.coin, path.from, path.to)?.feeUsd ?? 0;
  return Number(floorToStep(Number(row.amount) - fee, TRANSFER_STEP));
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

  const reopenOf = (index: number): Step | null => {
    if (!job.steps[index]?.name.startsWith('Convert')) return null;
    const next = job.steps.slice(index + 1).find((later) => !later.name.startsWith('Convert'));
    if (next?.name === 'Reopen') return next;
    return next?.name === SLICE_STEP && job.steps[index].retry ? next : null;
  };

  const legOf = (step: Step): RealizeJobLeg | undefined =>
    job.realize?.legs.find((leg) => leg.symbol === step.perp?.symbol);

  const openOf = (leg: RealizeJobLeg, reopen: Step): number => leg.filledQty - (reopen.qty ?? 0);

  let liveUnchecked = job.steps.slice(job.stepIndex).find((step) => !step.name.startsWith('Convert'))?.name === 'Reopen';

  const isSent = (step: Step): boolean => step.quoteId !== null || step.venueId !== null;

  const skipToReopen = (reopen: Step): void => {
    const current = job.steps[job.stepIndex];
    if (isSent(current)) {
      current.status = 'pending';
      current.startedAt = null;
      job.steps.splice(job.stepIndex, 1);
      job.steps.splice(job.steps.indexOf(reopen) + 1, 0, current);
    }
    const at = job.steps.indexOf(reopen);
    for (const step of job.steps.slice(job.stepIndex, at)) {
      step.status = 'done';
      step.qty ??= 0;
      step.doneAt = deps.now();
      delete step.sentAt;
    }
    job.stepIndex = at;
    deps.jobs.write(job);
  };

  const reopenAhead = (reason: string): Step | null => {
    const reopen = reopenOf(job.stepIndex);
    if (!reopen || !legOf(reopen)) return null;
    return reopen.retry && reason === HALT_TEXT.quotesUsed ? null : reopen;
  };

  const hedgeOpen = (): boolean => {
    const current = job.steps[job.stepIndex];
    const reopen = reopenOf(job.stepIndex) ?? (current?.name === 'Reopen' ? current : null);
    const leg = reopen ? legOf(reopen) : undefined;
    return job.notHedgedQty > 0 || (reopen !== null && leg !== undefined && openOf(leg, reopen) > 0);
  };

  const halt = (reason: string, kind?: HaltKind): void => {
    const ahead = reopenAhead(reason);
    if (ahead) {
      skipToReopen(ahead);
      return;
    }
    setBorosGap(job);
    const reopen = reopenOf(job.stepIndex);
    const leg = reopen ? legOf(reopen) : undefined;
    const quotesGone = reason === HALT_TEXT.quotesUsed;
    job.status = 'halted';
    job.haltKind = kind ?? (hedgeOpen() ? 'not-hedged' : 'other');
    job.haltReason = reopen && leg && quotesGone ? REOPEN_HALT.quotesUsedLegOpen(leg, openOf(leg, reopen)) : reason;
    deps.jobs.write(job);
    deps.onHalt(job);
    deps.onDone?.();
  };

  const haltDead = (step: Step, reason: string): void => {
    step.venueId = null;
    step.text = null;
    step.quoteId = null;
    delete step.sentAt;
    delete step.cashBefore;
    step.attempt += 1;
    halt(reason);
  };

  const finish = (step: Step, qty: number, fundsAt: FundsAt): void => {
    step.qty = qty;
    step.status = 'done';
    step.doneAt = deps.now();
    job.fundsAt = fundsAt;
    if (fundsAt !== 'GATE' && fundsAt !== 'SPOT') deps.cache.bust('account');
    if (job.stepIndex === job.steps.length - 1) job.status = 'done';
    else job.stepIndex += 1;
    deps.jobs.write(job);
    if (job.status === 'done') deps.onDone?.();
  };

  const previousQty = (): number => job.steps[job.stepIndex - 1]?.qty ?? 0;

  const convertSpec = (step: Step) => {
    const toUsdc = step.name === 'Convert to USDC' || (step.name === 'Convert' && step.from === 'CROSSEX');
    const venue = toUsdc ? step.to : step.from;
    return toUsdc
      ? { venue, fromCoin: 'USDT', toCoin: 'USDC', dest: venue as FundsAt, symbol: `${venue}_CONVERT_USDT_USDC` }
      : { venue, fromCoin: 'USDC', toCoin: 'USDT', dest: 'CROSSEX' as FundsAt, symbol: `${venue}_CONVERT_USDC_USDT` };
  };

  const sameMove = (a: Step) => (b: Step) => a.from === b.from && a.to === b.to;

  const afterLast = (match: (step: Step) => boolean): number =>
    job.steps.reduce((last, step, index) => (match(step) ? index + 1 : last), 0);

  const renumberRounds = (): void => {
    let count = 0;
    let last: number | null = null;
    for (const step of job.steps) {
      if (step.round === null) continue;
      if (step.round !== last) count += 1;
      last = step.round;
      step.round = count;
    }
  };

  const growConvert = (amount: number, current: Step): void => {
    const pending = job.steps.filter(
      (step, index) =>
        index >= job.stepIndex &&
        step.round === null &&
        step.name.startsWith('Convert') &&
        step.status === 'pending' &&
        sameMove(current)(step),
    );
    if (pending.length === 0) {
      const at = Math.max(job.stepIndex, afterLast(sameMove(current)));
      job.steps.splice(at, 0, ...convertSteps(current.from, current.to, amount));
      return;
    }
    const given = pending
      .filter((step) => step.name !== 'Convert to USDC')
      .reduce((total, step) => total + (step.planned ?? 0), 0);
    const at = job.steps.indexOf(pending[pending.length - 1]) + 1 - pending.length;
    for (const step of pending) job.steps.splice(job.steps.indexOf(step), 1);
    job.steps.splice(at, 0, ...convertSteps(current.from, current.to, nearestCents(given + amount)));
  };

  const dropRounds = (current: Step): void => {
    const rest = job.steps.slice(job.stepIndex);
    const dropping = (step: Step): boolean => step.round !== null && sameMove(current)(step);
    const dropped = rest
      .filter((step) => dropping(step) && MOVES_OUT.includes(step.name))
      .reduce((total, step) => total + (step.planned ?? 0), 0);
    job.steps = [...job.steps.slice(0, job.stepIndex), ...rest.filter((step) => !dropping(step))];
    growConvert(nearestCents(dropped), current);
    renumberRounds();
    deps.jobs.write(job);
  };

  const setRoundFigures = (step: Step, size: number): void => {
    const intoFromUsdt = INTO_VENUE.includes(step.name) && step.from === 'CROSSEX';
    if (MOVES_OUT.includes(step.name) || intoFromUsdt) step.planned = size;
    if (ROUND_ARRIVALS.includes(step.name) || (INTO_VENUE.includes(step.name) && !intoFromUsdt)) {
      step.planned = spotArrivalFor(step.from, size);
    }
    if (INTO_VENUE.includes(step.name)) step.arrives = arrivesFor(step.from, step.to, size);
  };

  const appendRound = (size: number, current: Step): void => {
    const after = afterLast((step) => step.round !== null && sameMove(current)(step));
    const round = (job.steps[after - 1]?.round ?? 0) + 1;
    for (const later of job.steps.slice(after)) if (later.round !== null) later.round += 1;
    const figures = { from: current.from, to: current.to, round, planned: size, arrives: null, borrowLeft: null };
    const added = roundStepNames(current.from, current.to).map((name) => pendingStep(name, figures));
    for (const step of added) setRoundFigures(step, size);
    job.steps.splice(after, 0, ...added);
  };

  const staticRead = async <T>(key: string, fetch: () => Promise<T>): Promise<T | null> => {
    try {
      return (await deps.cache.get(key, TTL.static, fetch)).value;
    } catch {
      return null;
    }
  };

  const usdcMinimum = async (): Promise<number> => {
    const coins = await staticRead('transfer:coins', async () => (await crossEx().listCrossexTransferCoins()).body);
    const minimum = Number(coins?.find((coin) => coin.coin === 'USDC')?.minTransAmount);
    return Number.isFinite(minimum) && minimum > 0 ? minimum : HYPERLIQUID_MIN_USDC;
  };

  const orderMax = async (price: number): Promise<number> => {
    const rules = await staticRead('rules:all', async () => (await crossEx().listCrossexRuleSymbols()).body);
    const size = Number(rules?.find((rule) => rule.symbol === SPOT_SYMBOL)?.maxMarketSize);
    return spotOrderMax(price, Number.isFinite(size) && size > 0 ? size : undefined);
  };

  const sellChain = (step: Step): Step[] => {
    const chain: Step[] = [];
    for (let index = job.steps.indexOf(step); index >= 0; index -= 1) {
      const earlier = job.steps[index];
      if (earlier.name !== 'Sell USDC' || earlier.round !== step.round || !sameMove(step)(earlier)) break;
      chain.unshift(earlier);
    }
    return chain;
  };

  const sizeRound = async (step: Step, plannedMove: number, sending: Sending, margins: Margins): Promise<number | null> => {
    const planned = floorCents(plannedMove);
    const minimum = roundMinimum(step.from, step.to, await usdcMinimum());
    const size = fit(margins, Math.min(planned, sending.cash), sending.equity);
    if (size >= planned) return planned;
    const marginFit = fit(margins, planned, sending.equity);
    if (size < minimum) {
      if (job.route === 'mix') dropRounds(step);
      else halt(marginFit < minimum ? HALT_TEXT.marginTooLow : HALT_TEXT.cashTooLow);
      return null;
    }
    const shrink = nearestCents(planned - size);
    if (shrink >= DUST_USDC && marginFit < planned) {
      if (job.route === 'loop' && shrink >= minimum) appendRound(shrink, step);
      else growConvert(shrink, step);
    }
    for (const later of job.steps.slice(job.stepIndex)) {
      if (later.round === step.round) setRoundFigures(later, size);
      later.borrowLeft = null;
    }
    deps.jobs.write(job);
    return size;
  };

  const spotTicker = (): Promise<SpotTicker> => readSpotTicker(deps.clients());

  const spotDepth = async (): Promise<Pick<SpotDepth, 'asks' | 'bids'>> => {
    try {
      return bookLevels((await deps.clients().spot.listOrderBook(SPOT_PAIR, { limit: 100 })).body);
    } catch {
      return bookLevels(null);
    }
  };

  const cashFit = (usdc: number, depth: AskDepth, budget: number): number => {
    if (ceilCents(buyCostUsdt(usdc, depth)) <= budget) return usdc;
    let cents = Math.floor(Math.min(usdc, buyableUsdc(budget, depth)) * 100);
    while (cents > 0 && ceilCents(buyCostUsdt(cents / 100, depth)) > budget) cents -= 1;
    return cents / 100;
  };

  const keepCut = async (step: Step, cut: number, bought: number): Promise<void> => {
    if (cut < DUST_USDC) return;
    const minimum = roundMinimum(step.from, step.to, await usdcMinimum());
    if (job.route === 'loop' && cut >= minimum) appendRound(cut, step);
    else growConvert(cut, step);
    for (const later of job.steps.slice(job.stepIndex)) {
      if (later.round === step.round) setRoundFigures(later, bought);
      later.borrowLeft = null;
    }
    deps.jobs.write(job);
  };

  const sellMax = (ticker: { ask: number; bid: number }): Promise<number> =>
    orderMax(Math.max(...[ticker.bid, ticker.ask].filter((price) => Number.isFinite(price))));

  const prepareBuy = async (step: Step): Promise<number | null> => {
    const move = job.steps.find((later, index) => index > job.stepIndex && later.name === 'To spot');
    if (!move) throw new Error('Buy USDC has no To spot step');
    const account = await readAccount(crossEx());
    const gateCash = account.cash(GATE_WALLET);
    const movable = gateCash >= DUST_USDC ? gateCash : 0;
    step.cashBefore = Number.isFinite(gateCash) ? Math.max(0, gateCash) : 0;
    const { ask } = await spotTicker();
    const price = Number.isFinite(ask) && ask > 0 ? ask : 1;
    const depth = { ask: price, asks: (await spotDepth()).asks };
    const budget = floorCents(Math.max(0, account.cash(USDT_WALLET)));
    const buyable = budget >= SPOT_MIN_QUOTE_USDT ? floorCents(buyableUsdc(budget, depth)) : 0;
    const sending = {
      cash: buyable + movable,
      equity: Math.max(0, account.equity(USDT_WALLET)) + movable,
    };
    const size = await sizeRound(step, move.planned ?? 0, sending, account.margins);
    if (size === null) return null;
    if (movable >= size) {
      finish(step, 0, 'GATE');
      return null;
    }
    const wanted = size - movable;
    const rest = cashFit(Math.min(wanted, await orderMax(ask)), depth, budget);
    await keepCut(step, nearestCents(wanted - rest), floorCents(movable + rest));
    deps.jobs.write(job);
    return Math.min(Math.max(SPOT_MIN_QUOTE_USDT, ceilCents(buyCostUsdt(rest, depth))), budget);
  };

  const lagging = (step: Step, cash: number, before: number, arrived: number): boolean => {
    if (cash < arrived - Number(CENT_STEP)) return true;
    const unmoved = Math.abs(cash - before) < Number(CENT_STEP);
    const waiting = unmoved || deps.now() - (step.startedAt ?? 0) < BALANCE_LAG_MS;
    return waiting && cash < before + arrived - Number(CENT_STEP);
  };

  const prepareToSpot = async (step: Step): Promise<number | null> => {
    const account = await readAccount(crossEx());
    const gateCash = account.cash(GATE_WALLET);
    const buy = job.steps[job.stepIndex - 1];
    const roundBuy = buy?.name === 'Buy USDC' && buy.round === step.round;
    const boughtQty = roundBuy ? (buy.qty ?? 0) : 0;
    const bought = boughtQty > 0;
    const cashBefore = roundBuy ? (buy.cashBefore ?? 0) : 0;
    if (bought && lagging(step, gateCash, cashBefore, boughtQty)) {
      await deps.sleep(POLL_MS);
      return null;
    }
    if (bought && gateCash < HYPERLIQUID_MIN_USDC) {
      halt(HALT_TEXT.shortBuy);
      return null;
    }
    if (roundBuy && gateCash <= (step.planned ?? 0) - DUST_USDC) {
      const landed = floorCents(gateCash);
      await keepCut(step, nearestCents((step.planned ?? 0) - landed), landed);
    }
    const equity = Math.max(0, account.equity(USDT_WALLET)) + (gateCash >= DUST_USDC ? gateCash : 0);
    return await sizeRound(step, step.planned ?? 0, { cash: gateCash, equity }, account.margins);
  };

  const prepareFromVenue = async (step: Step): Promise<number | null> => {
    const account = await readAccount(crossEx());
    const wallet = poolWallet(step.from);
    const sending = { cash: Math.max(0, account.cash(wallet)), equity: account.equity(wallet) };
    return await sizeRound(step, step.planned ?? 0, sending, account.margins);
  };

  const prepareConvert = async (step: Step): Promise<number | null> => {
    const account = await readAccount(crossEx());
    const gateCash = account.cash(GATE_WALLET);
    if (step.name === 'Convert' && step.phase !== 'realize' && gateCash >= DUST_USDC && !reopenOf(job.stepIndex)) {
      const { bid } = await spotTicker();
      if (gateCash * bid >= SPOT_MIN_QUOTE_USDT) {
        const planned = floorCents(gateCash);
        const sell = { from: step.from, to: step.to, round: null, planned, arrives: null, borrowLeft: null };
        job.steps.splice(job.stepIndex, 0, pendingStep('Sell USDC', sell));
        step.status = 'pending';
        step.startedAt = null;
        deps.jobs.write(job);
        return null;
      }
    }
    const spec = convertSpec(step);
    const firstHalf = step.name === 'Convert to USDT' && job.steps[job.stepIndex + 1]?.name === 'Convert to USDC';
    if (firstHalf && account.cash(USDT_WALLET) < -DUST_USDC) {
      halt(HALT_TEXT.usdtBelowZero);
      return null;
    }
    const sending = Math.max(0, account.cash(spec.fromCoin === 'USDT' ? USDT_WALLET : poolWallet(spec.venue)));
    const half = job.steps[job.stepIndex - 1];
    const converted = step.name === 'Convert to USDC' && half?.name === 'Convert to USDT' && half.status === 'done';
    const target = floorCents(converted ? (half.qty ?? 0) : (step.planned ?? 0));
    const amount = capToBalance(target, sending);
    if (converted && amount <= 0 && target > 0) {
      halt(HALT_TEXT.usdtBelowZero);
      return null;
    }
    const chunkDone = job.steps
      .slice(0, job.stepIndex)
      .some((earlier) => earlier.round === null && earlier.name.startsWith('Convert') && earlier.status === 'done' && sameMove(step)(earlier));
    if (amount <= 0 && (converted || chunkDone)) {
      finish(step, 0, spec.dest);
      return null;
    }
    return amount;
  };

  const prepareToGate = async (step: Step): Promise<number> => {
    if (step.cashBefore === undefined) {
      const gateCash = (await readAccount(crossEx())).cash(GATE_WALLET);
      step.cashBefore = Number.isFinite(gateCash) ? Math.max(0, gateCash) : 0;
      deps.jobs.write(job);
    }
    return previousQty();
  };

  const prepareSell = async (step: Step): Promise<number | null> => {
    const account = await readAccount(crossEx());
    const cash = account.cash(GATE_WALLET);
    const first = step.round !== null && sellChain(step).length <= 1;
    const arrived = first ? previousQty() : 0;
    const toGate = job.steps[job.stepIndex - 1];
    const landed = toGate?.name === 'To Gate' && toGate.status === 'done';
    if (first && landed && lagging(step, cash, toGate.cashBefore ?? 0, arrived)) {
      await deps.sleep(POLL_MS);
      return null;
    }
    const amount = capToBalance(cash - arrived >= DUST_USDC ? cash : Math.min(cash, arrived), cash);
    const nothingToSell = (): null => {
      finish(step, 0, 'CROSSEX');
      return null;
    };
    if (amount < DUST_USDC) return nothingToSell();
    const ticker = await spotTicker();
    const quote = Number.isFinite(ticker.bid) && ticker.bid > 0 ? amount * ticker.bid : amount;
    if (quote < SPOT_MIN_QUOTE_USDT) return nothingToSell();
    return Math.min(amount, await sellMax(ticker));
  };

  const sellRest = async (step: Step, sold: number): Promise<boolean> => {
    const cash = (await readAccount(crossEx())).cash(GATE_WALLET);
    if (cash < DUST_USDC) return false;
    const ticker = await spotTicker();
    const quote = Number.isFinite(ticker.bid) && ticker.bid > 0 ? cash * ticker.bid : cash;
    if (quote < SPOT_MIN_QUOTE_USDT) return false;
    const chain = sellChain(step);
    const start = chain[1]?.planned ?? floorCents(cash + (Number.isFinite(sold) ? sold : 0));
    const limit = Math.ceil(start / (await sellMax(ticker))) + 2;
    const rest = { from: step.from, to: step.to, round: step.round, planned: start, arrives: null, borrowLeft: null };
    job.steps.splice(job.steps.indexOf(step) + 1, 0, pendingStep('Sell USDC', rest));
    return chain.length >= limit;
  };

  const prepare = (step: Step): Promise<number | null> | number => {
    switch (step.name as StepName) {
      case 'Buy USDC':
        return prepareBuy(step);
      case 'To spot':
        return prepareToSpot(step);
      case 'From Hyperliquid':
      case 'From Lighter':
        return prepareFromVenue(step);
      case 'Convert':
      case 'Convert to USDT':
      case 'Convert to USDC':
        return prepareConvert(step);
      case 'Sell USDC':
        return prepareSell(step);
      case 'To Gate':
        return prepareToGate(step);
      default:
        return previousQty();
    }
  };

  const poll = async (step: Step, spec: MoneySpec, venueId: string): Promise<void> => {
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
      const sell = spec.kind === 'order' && spec.side === CrossexOrderRequest.Side.SELL;
      if (filled > 0) {
        if (spec.kind === 'convert' && job.slice) job.totalCostUsd = nearestCents((job.totalCostUsd ?? 0) + Math.max(0, positiveOf(String(body.executedQty ?? '')) - filled));
        if (spec.kind === 'convert') await trimAfterRetry(step, Number(body.executedQty) || (step.planned ?? 0));
        const stuck = sell && (await sellRest(step, Number(body.executedQty)));
        finish(step, filled, spec.kind === 'convert' ? convertSpec(step).dest : spec.dest);
        if (stuck) halt(HALT_TEXT.sellStuck);
      } else if (spec.kind === 'convert' && retryPastReopen(step)) finish(step, 0, job.fundsAt);
      else if (sell && sellChain(step).length > 1) haltDead(step, HALT_TEXT.sellStuck);
      else haltDead(step, HALT_TEXT.nothingFilled);
      return;
    }
    const row = await transferRow(crossEx(), spec.coin, (r) => String(r.id) === venueId);
    if (!row) return;
    const status = String(row.status ?? '');
    if (status === 'SUCCESS') {
      const received = receivedOf(row, spec);
      if (received > 0) finish(step, received, spec.dest);
      else halt(HALT_TEXT.nothingReceived);
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

  const sweep = async (step: Step, spec: StepSpec, tag: string): Promise<string | null | undefined> => {
    if (spec.kind === 'transfer') return null;
    const symbol = spec.kind === 'convert' ? convertSpec(step).symbol : (step.perp?.symbol ?? SPOT_SYMBOL);
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

  const pricedTicker = async (gives: TransferCoin): Promise<SpotTicker | null> => {
    const ticker = await spotTicker().catch(() => null);
    const price = Number(gives === 'USDC' ? ticker?.ask : ticker?.bid);
    return Number.isFinite(price) && price > 0 ? ticker : null;
  };

  let lastQuoteAt = Number.NEGATIVE_INFINITY;
  let quoting = false;

  const sendConvert = async (step: Step, amount: number): Promise<void> => {
    if (amount > CONVERT_MAX) {
      halt(HALT_TEXT.convertTooBig);
      return;
    }
    const spec = convertSpec(step);
    const wait = lastQuoteAt + CONVERT_GAP_MS - deps.now();
    if (wait > 0) await deps.sleep(wait);
    const gives: TransferCoin = spec.toCoin === 'USDC' ? 'USDC' : 'USDT';
    let ticker = await pricedTicker(gives);
    if (!ticker) {
      await deps.sleep(POLL_MS);
      ticker = await pricedTicker(gives);
    }
    if (!ticker) {
      halt(HALT_TEXT.noPrice);
      return;
    }
    lastQuoteAt = deps.now();
    quoting = true;
    const { body: quote } = await crossEx().createCrossexConvertQuote({
      crossexConvertQuoteRequest: {
        exchangeType: spec.venue,
        fromCoin: spec.fromCoin,
        toCoin: spec.toCoin,
        fromAmount: stripZeros(floorToStep(amount, CENT_STEP)),
      },
    });
    quoting = false;
    const toAmount = Number(quote.toAmount);
    if (!(toAmount >= quoteFloor(amount, gives, ticker))) {
      halt(HALT_TEXT.poorQuote);
      return;
    }
    // On disk before the send: if the response is lost, the quote id is the
    // key that finds the order on Gate, so the step is never sent twice.
    step.quoteId = String(quote.quoteId);
    step.qty = toAmount;
    step.sentAt = deps.now();
    deps.jobs.write(job);
    const { body } = await crossEx().createCrossexConvertOrder({
      crossexConvertOrderRequest: { quoteId: step.quoteId },
    });
    if (!body.orderId) throw new Error('convert order response has no orderId');
    step.venueId = String(body.orderId);
    await trimAfterRetry(step, amount);
    finish(step, toAmount, spec.dest);
  };

  const send = async (step: Step, spec: MoneySpec, tag: string, amount: number): Promise<void> => {
    if (spec.kind === 'convert') return sendConvert(step, amount);
    step.sentAt = deps.now();
    deps.jobs.write(job);
    if (spec.kind === 'transfer') {
      step.venueId = await sendTransfer(crossEx(), { coin: spec.coin, amount, from: spec.from, to: spec.to, text: tag });
    } else {
      const size =
        spec.side === CrossexOrderRequest.Side.SELL
          ? { qty: floorToStep(amount, CENT_STEP) }
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

  const perpRule = async (symbol: string): Promise<{ lot: string; limits: PerpRule }> => {
    const rules = await staticRead('rules:all', async () => (await crossEx().listCrossexRuleSymbols()).body);
    const rule = rules?.find((candidate) => candidate.symbol === symbol);
    if (!rule || !(positiveOf(rule.lotSize) > 0)) throw new Error(`Gate has no order rules for ${symbol}`);
    return { lot: rule.lotSize, limits: rule };
  };

  const isCloseOnly = async (symbol: string): Promise<boolean> => {
    try {
      const { body } = await crossEx().listCrossexRuleSymbols({ symbols: symbol });
      const rule = (body ?? []).find((candidate) => candidate.symbol === symbol);
      return rule !== undefined && (rule.state !== 'live' || positiveOf(rule.delistTime) > 0);
    } catch {
      return false;
    }
  };

  const findSent = async (step: Step, tag: string): Promise<string | null | undefined> =>
    (await lookUpInWindow(deps, () => lookup(STEPS.Close, tag))) ?? (await sweep(step, STEPS.Close, tag));

  const sendPerp = async (step: Step, perp: StepPerp, tag: string, qty: string): Promise<void> => {
    const { body } = await crossEx().createCrossexOrder({
      crossexOrderRequest: {
        symbol: perp.symbol,
        side: perp.side === 'BUY' ? CrossexOrderRequest.Side.BUY : CrossexOrderRequest.Side.SELL,
        type: CrossexOrderRequest.Type.MARKET,
        timeInForce: CrossexOrderRequest.TimeInForce.IOC,
        qty,
        text: tag,
        ...(perp.reduceOnly ? { reduceOnly: CrossexOrderRequest.ReduceOnly.True } : {}),
      },
    });
    if (!body.orderId) throw new Error('order response has no orderId');
    step.venueId = String(body.orderId);
    deps.jobs.write(job);
  };

  const hasQuoteLeft = async (convert: Step, amount: number): Promise<boolean> => {
    const spec = convertSpec(convert);
    const wait = lastQuoteAt + CONVERT_GAP_MS - deps.now();
    if (wait > 0) await deps.sleep(wait);
    lastQuoteAt = deps.now();
    try {
      await crossEx().createCrossexConvertQuote({
        crossexConvertQuoteRequest: {
          exchangeType: spec.venue,
          fromCoin: spec.fromCoin,
          toCoin: spec.toCoin,
          fromAmount: stripZeros(floorToStep(amount, CENT_STEP)),
        },
      });
      return true;
    } catch (err) {
      const c = classifyGateError(err);
      if (c.category === 'insufficient-margin') return true;
      if (c.category !== 'rate-limited') throw err;
      return false;
    }
  };

  const checkQuotes = async (account: Account): Promise<boolean> => {
    if (job.steps.findIndex((step) => step.name === 'Close') !== job.stepIndex) return true;
    const kinds = new Map<string, Step>();
    for (const [index, step] of job.steps.entries()) {
      if (reopenOf(index) !== null && !kinds.has(convertSpec(step).symbol)) kinds.set(convertSpec(step).symbol, step);
    }
    for (const convert of kinds.values()) {
      const spec = convertSpec(convert);
      const wallet = spec.fromCoin === 'USDT' ? USDT_WALLET : poolWallet(spec.venue);
      const amount = Math.min(floorCents(convert.planned ?? 0), floorCents(Math.max(0, account.cash(wallet))));
      if (amount < HYPERLIQUID_MIN_USDC || (await hasQuoteLeft(convert, amount))) continue;
      await deps.sleep(REOPEN_MAX_WAIT_MS);
      if (await hasQuoteLeft(convert, amount)) continue;
      halt(HALT_TEXT.quotesUsed);
      return false;
    }
    return true;
  };

  const trimRoute = async (missing: number): Promise<void> => {
    const start = job.steps.reduce((last, step, index) => (step.name === 'Reopen' || step.name === SLICE_STEP ? index : last), -1) + 1;
    const groups: Step[][] = [];
    for (const step of job.steps.slice(start).filter((later) => !isSent(later))) {
      const last = groups.at(-1);
      const joins = last !== undefined && (step.name === 'Convert to USDC' || (step.round !== null && step.round === last[0].round));
      if (last && joins) last.push(step);
      else groups.push([step]);
    }
    let left = missing;
    for (const group of groups.reverse()) {
      if (left < DUST_USDC) break;
      const head = group[0];
      const move = group.find((step) => MOVES_OUT.includes(step.name) || step.round === null)?.planned ?? 0;
      const size = floorCents(move - Math.min(left, move));
      const minimum = head.round === null ? DUST_USDC : roundMinimum(head.from, head.to, await usdcMinimum());
      if (size < minimum) {
        job.steps = job.steps.filter((step) => !group.includes(step));
        left = nearestCents(left - move);
        continue;
      }
      left = nearestCents(left - (move - size));
      if (head.round !== null) {
        for (const step of group) setRoundFigures(step, size);
        continue;
      }
      head.planned = size;
      if (group[1]) group[1].planned = floorCents(size * (1 - CONVERT_RATE));
    }
    renumberRounds();
  };

  const trimAfterRetry = async (step: Step, given: number): Promise<void> => {
    if (step.retry) await trimRoute(nearestCents(given));
  };

  const retryPastReopen = (step: Step): boolean => Boolean(step.retry) && !reopenOf(job.stepIndex);

  const pollClose = async (step: Step, leg: RealizeJobLeg, venueId: string): Promise<void> => {
    const { body } = await crossEx().getCrossexOrder(venueId);
    if (decodeStatus(String(body.state ?? '')) !== 'closed') return;
    const filled = Number(body.executedQty ?? 0);
    if (!(filled > 0)) return haltDead(step, HALT_TEXT.nothingFilled);
    const account = await readAccount(crossEx());
    const arrived = Math.max(0, account.cash(poolWallet(step.from)) - (step.cashBefore ?? 0));
    leg.filledQty = filled;
    leg.realizedUsd = nearestCents(arrived);
    if (positiveOf(body.executedAvgPrice) > 0) leg.closePrice = positiveOf(body.executedAvgPrice);
    if (filled < leg.qty) await trimRoute(nearestCents((arrived * (leg.qty - filled)) / filled));
    finish(step, filled, step.from);
  };

  const runClose = async (step: Step, perp: StepPerp, leg: RealizeJobLeg): Promise<void> => {
    let phase: 'poll' | 'lookup' | 'read' | 'send' = 'poll';
    try {
      if (step.venueId !== null) {
        await pollClose(step, leg, step.venueId);
        if (job.status === 'running' && step.status !== 'done') await deps.sleep(POLL_MS);
        return;
      }
      if (step.text !== null) {
        phase = 'lookup';
        const found = await findSent(step, step.text);
        if (found === undefined) return halt(HALT_TEXT.unconfirmed);
        if (found !== null) {
          step.venueId = found;
          deps.jobs.write(job);
          return;
        }
        if (step.sentAt !== undefined) {
          delete step.sentAt;
          return halt(HALT_TEXT.notListed);
        }
      }
      if (deps.pollOnly) return halt(HALT_TEXT.restart, 'restart');
      phase = 'read';
      const { lot } = await perpRule(perp.symbol);
      const account = await readAccount(crossEx());
      step.cashBefore = account.cash(poolWallet(step.from));
      if (!(await checkQuotes(account))) return;
      if (step.text === null) {
        job.tagCount += 1;
        step.text = tagFor(job.id, job.tagCount);
      }
      step.sentAt = deps.now();
      deps.jobs.write(job);
      phase = 'send';
      await sendPerp(step, perp, step.text, stripZeros(floorToStep(leg.qty, lot)));
    } catch (err) {
      const c = classifyGateError(err);
      if (phase === 'poll') return deps.sleep(POLL_MS);
      if (phase === 'send' && (isRefusal(c) || c.category === 'rate-limited')) {
        delete step.sentAt;
        deps.jobs.write(job);
      }
      if (phase === 'send' && c.category === 'rate-limited') return halt(HALT_TEXT.rateLimited);
      if (c.retryable) return deps.sleep(POLL_MS);
      if (phase !== 'send' || isRefusal(c)) return halt(haltReasonFor(err));
      await deps.sleep(POLL_MS);
    }
  };

  const nextTry = (step: Step, retry: StepRetry | null): void => {
    const n = Number((step.text ?? '').slice(`t-rb${job.id}`.length).split('x')[0]);
    step.attempt += 1;
    step.text = tagFor(job.id, n, step.attempt);
    step.nextTryAt = deps.now() + Math.min(REOPEN_FIRST_WAIT_MS * 2 ** (step.attempt - 1), REOPEN_MAX_WAIT_MS);
    step.retry = retry;
    step.venueId = null;
    delete step.sentAt;
    deps.jobs.write(job);
  };

  const restOf = async (step: Step, leg: RealizeJobLeg): Promise<{ lots: number; qty: string; under: boolean }> => {
    const { lot, limits } = await perpRule(leg.symbol);
    const lots = Math.max(0, lotsOf(leg.filledQty, lot) - lotsOf(step.qty ?? 0, lot));
    const qty = stripZeros(roundToStep(lots * Number(lot), lot, 'nearest'));
    const mark = leg.closePrice ?? 0;
    const minimum = mark > 0 ? minQtyOf(limits, lot, mark) : positiveOf(limits.minSize);
    return { lots, qty, under: lots > 0 && Number(qty) < minimum };
  };

  const leftLots = (held: RealizeJobLeg, lot: string): number => {
    const reopen = job.steps.find((step) => step.name === 'Reopen' && step.perp?.symbol === held.symbol);
    return lotsOf(held.positionQty, lot) - lotsOf(held.filledQty, lot) + lotsOf(reopen?.qty ?? 0, lot);
  };

  const liveMismatch = async (leg: RealizeJobLeg): Promise<string | null> => {
    const positions = (await crossEx().listCrossexPositions()).body ?? [];
    const liveOf = (symbol: string, side: RealizeJobLeg['side']): number => {
      const signed = Number(positions.find((position) => position.symbol === symbol)?.positionQty ?? 0);
      if (!Number.isFinite(signed)) throw new Error(`Gate sent no position size for ${symbol}`);
      return side === 'SHORT' ? -signed : signed;
    };
    const sizeOf = (lots: number, lot: string): number => Number(roundToStep(lots * Number(lot), lot, 'nearest'));
    const { lot } = await perpRule(leg.symbol);
    const live = liveOf(leg.symbol, leg.side);
    const expected = leftLots(leg, lot);
    if (lotsOf(live, lot) !== expected) return REOPEN_HALT.sizeChanged(leg, Math.max(0, live), sizeOf(expected, lot));
    for (const hedge of hedgesOf(leg, job.before?.perps ?? [])) {
      const rule = await perpRule(hedge.symbol);
      const held = job.realize?.legs.find((other) => other.symbol === hedge.symbol);
      const hedgeLots = held ? leftLots(held, rule.lot) : lotsOf(hedge.qty, rule.lot);
      const hedgeLive = liveOf(hedge.symbol, hedge.side);
      if (lotsOf(hedgeLive, rule.lot) === hedgeLots) continue;
      return REOPEN_HALT.hedgeChanged(leg, hedge, Math.max(0, hedgeLive), sizeOf(hedgeLots, rule.lot));
    }
    return null;
  };

  const marginPerCoin = async (leg: RealizeJobLeg): Promise<number> => {
    const held = ((await crossEx().listCrossexPositions()).body ?? []).find((position) => position.symbol === leg.symbol);
    const qty = Math.abs(Number(held?.positionQty));
    const margin = Math.abs(Number(held?.initialMargin));
    if (qty > 0 && margin > 0) return margin / qty;
    const close = job.steps.find((step) => step.name === 'Close' && step.perp?.symbol === leg.symbol);
    if (!close?.venueId) return 0;
    const { body } = await crossEx().getCrossexOrder(close.venueId);
    const leverage = positiveOf(body.leverage);
    return leverage > 0 ? positiveOf(body.executedAvgPrice) / leverage : 0;
  };

  const retryConvert = async (step: Step, leg: RealizeJobLeg): Promise<void> => {
    const account = await readAccount(crossEx());
    const cash = floorCents(Math.max(0, account.cash(poolWallet(leg.pool))));
    if (cash < HYPERLIQUID_MIN_USDC) return halt(REOPEN_HALT.noCash, 'margin');
    const need = openOf(leg, step) * (await marginPerCoin(leg));
    const whole = ceilCents((need / marginPerConvertUsdc) * RETRY_CONVERT_HEADROOM);
    const convertAmount = Math.min(cash, Math.max(HYPERLIQUID_MIN_USDC, whole));
    step.retry = { reason: 'margin', convertAmount };
    const converts = asRealize(convertSteps(leg.pool, CONVERT_TO[leg.pool], convertAmount)).map((convert) => ({ ...convert, retry: step.retry }));
    job.steps.splice(job.steps.indexOf(step), 0, ...converts);
    deps.jobs.write(job);
  };

  const retryConvertCapped = async (step: Step, leg: RealizeJobLeg): Promise<void> => {
    if (job.retryConverts >= RETRY_CONVERT_CAP) return halt(REOPEN_HALT.noCash, 'margin');
    const account = await readAccount(crossEx());
    if (account.borrow(poolWallet(CONVERT_TO[leg.pool])) === 0) return halt(REOPEN_HALT.noCash, 'margin');
    job.retryConverts += 1;
    return retryConvert(step, leg);
  };

  const afterTry = async (step: Step, leg: RealizeJobLeg, err: unknown): Promise<void> => {
    if (err === null) return;
    const c = classifyGateError(err);
    if (c.category === 'rate-limited' || ORDER_ALLOWANCE_LABELS.includes(c.label ?? '')) return;
    if (c.category === 'auth') return halt(REOPEN_HALT.tradePermission);
    if (c.category === 'insufficient-margin') return retryConvertCapped(step, leg);
    if (c.category === 'size-too-small' && (step.qty ?? 0) > 0) return finish(step, step.qty ?? 0, step.from);
    const open = Number((await restOf(step, leg)).qty);
    if (c.category === 'size-too-small') return halt(REOPEN_HALT.underMinimum(leg, open));
    if (c.label === DELIST_LABEL || (await isCloseOnly(leg.symbol))) return halt(REOPEN_HALT.closeOnly(leg, open));
    halt(REOPEN_HALT.refused(leg, open, haltReasonFor(err)));
  };

  const pollReopen = async (step: Step, leg: RealizeJobLeg, venueId: string): Promise<void> => {
    const { body } = await crossEx().getCrossexOrder(venueId);
    const state = String(body.state ?? '');
    if (decodeStatus(state) !== 'closed') return deps.sleep(POLL_MS);
    const filled = Number(body.executedQty ?? 0);
    const qty = (step.qty ?? 0) + (filled > 0 ? filled : 0);
    const rest = await restOf({ ...step, qty }, leg);
    step.qty = qty;
    if (rest.lots === 0 || rest.under) return finish(step, qty, step.from);
    nextTry(step, null);
    await afterTry(step, leg, /REJECT|FAIL/i.test(state) ? errorFromReason(String(body.reason ?? '') || state) : null);
  };

  const runReopen = async (step: Step, perp: StepPerp, leg: RealizeJobLeg): Promise<void> => {
    let phase: 'poll' | 'send' = 'poll';
    try {
      if (step.venueId !== null) return await pollReopen(step, leg, step.venueId);
      if (step.text !== null && step.sentAt !== undefined) {
        const found = await findSent(step, step.text);
        if (found === undefined) return await deps.sleep(POLL_MS);
        if (found === null) {
          liveUnchecked = true;
          return nextTry(step, null);
        }
        step.venueId = found;
        deps.jobs.write(job);
        return;
      }
      const wait = (step.nextTryAt ?? 0) - deps.now();
      if (wait > 0) await deps.sleep(wait);
      if (liveUnchecked) {
        const mismatch = await liveMismatch(leg);
        if (mismatch !== null) return halt(mismatch);
        liveUnchecked = false;
      }
      const rest = await restOf(step, leg);
      if (rest.lots === 0 || rest.under) return finish(step, step.qty ?? 0, step.from);
      const { qty } = rest;
      if (step.text === null) {
        job.tagCount += 1;
        step.text = tagFor(job.id, job.tagCount);
      }
      step.sentAt = deps.now();
      deps.jobs.write(job);
      phase = 'send';
      await sendPerp(step, perp, step.text, qty);
    } catch (err) {
      const c = classifyGateError(err);
      if (phase === 'send' && (isRefusal(c) || c.category === 'rate-limited' || c.category === 'auth')) {
        nextTry(step, null);
        return afterTry(step, leg, err);
      }
      if (c.category === 'auth') return halt(REOPEN_HALT.tradePermission);
      await deps.sleep(POLL_MS);
    }
  };

  const miss = (step: Step): void => {
    job.followMisses += 1;
    step.attempt += 1;
    step.nextTryAt = deps.now() + Math.min(REOPEN_FIRST_WAIT_MS * 2 ** (step.attempt - 1), REOPEN_MAX_WAIT_MS);
    deps.jobs.write(job);
  };

  const pauseNow = (): void => {
    job.status = 'halted';
    job.paused = true;
    job.pauseRequested = false;
    job.haltReason = null;
    job.haltKind = null;
    setBorosGap(job);
    deps.jobs.write(job);
    deps.onDone?.();
  };

  const findOrder = async (step: Step, perp: StepPerp, tag: string): Promise<string | null | undefined> =>
    (await lookUpInWindow(deps, () => lookup(STEPS.Close, tag))) ?? (await sweep({ ...step, perp }, STEPS.Close, tag));

  const followRefused = async (step: Step, leg: RealizeJobLeg, err: unknown): Promise<void> => {
    const c = classifyGateError(err);
    if (c.category === 'price-limit' || c.category === 'rate-limited' || ORDER_ALLOWANCE_LABELS.includes(c.label ?? '')) return miss(step);
    if (c.category === 'auth') return halt(REOPEN_HALT.tradePermission);
    if (c.category === 'insufficient-margin' && job.kind === 'realize') {
      miss(step);
      return retryConvertCapped(step, leg);
    }
    const open = openFollowOf(leg, step);
    const symbol = step.follow?.symbol ?? leg.symbol;
    if (c.category === 'size-too-small') return halt(REOPEN_HALT.underMinimum(leg, open));
    if (c.label === DELIST_LABEL || (await isCloseOnly(symbol))) return halt(REOPEN_HALT.closeOnly(leg, open));
    halt(REOPEN_HALT.refused(leg, open, haltReasonFor(err)));
  };

  const runFollow = async (step: Step, leg: RealizeJobLeg, follow: StepPerp, rule: SliceRule): Promise<void> => {
    syncFollow(job, step, leg);
    const order = step.hedge;
    if (order) {
      if (order.venueId === null) {
        const found = await findOrder(step, follow, order.text);
        if (found === undefined) return deps.sleep(POLL_MS);
        if (found === null) step.hedge = null;
        else order.venueId = found;
        deps.jobs.write(job);
        return;
      }
      const body = await readOrder(crossEx(), order.venueId);
      if (!body) return deps.sleep(POLL_MS);
      const { delta, closed } = creditOrder(job, order, body);
      step.qty = addQty(step.qty ?? 0, delta);
      if (!closed) {
        deps.jobs.write(job);
        return deps.sleep(POLL_MS);
      }
      step.hedge = null;
      syncFollow(job, step, leg);
      if (order.credited > 0) {
        job.followMisses = 0;
        step.attempt = 0;
        step.nextTryAt = null;
        deps.jobs.write(job);
        return;
      }
      const state = String(body.state ?? '');
      if (/REJECT|FAIL/i.test(state)) return followRefused(step, leg, errorFromReason(String(body.reason ?? '') || state));
      return miss(step);
    }
    const wait = (step.nextTryAt ?? 0) - deps.now();
    if (wait > 0) await deps.sleep(wait);
    const priced = await priceFor(deps, follow, rule, false);
    if (!priced) return miss(step);
    const lots = lotsOf(openFollowOf(leg, step), rule.lot);
    job.tagCount += 1;
    const sent: PerpOrder = { text: tagFor(job.id, job.tagCount), venueId: null, sentAt: deps.now(), credited: 0, poc: false, price: priced.price, side: follow.side, mid: priced.mid };
    step.hedge = sent;
    deps.jobs.write(job);
    try {
      sent.venueId = await placePerp(crossEx(), follow, sent.text, qtyText(lots, rule.lot), { kind: 'ioc', price: priced.price });
      deps.jobs.write(job);
    } catch (err) {
      const c = classifyGateError(err);
      if (!isRefusal(c) && c.category !== 'rate-limited' && c.category !== 'auth') return deps.sleep(POLL_MS);
      step.hedge = null;
      deps.jobs.write(job);
      return followRefused(step, leg, err);
    }
  };

  let leadMisses = 0;
  let rateLimits = 0;
  const leadMissed = (reason: string): boolean => {
    leadMisses += 1;
    if (leadMisses < FOLLOW_MISSES_RED) return false;
    halt(reason);
    return true;
  };

  const cancelLead = async (step: Step, leg: RealizeJobLeg, order: PerpOrder & { venueId: string }): Promise<void> => {
    await crossEx()
      .cancelCrossexOrder(order.venueId)
      .catch(() => undefined);
    const body = await readOrder(crossEx(), order.venueId);
    if (!body) return deps.sleep(POLL_MS);
    const { delta, closed } = creditOrder(job, order, body, leg);
    leg.filledQty = addQty(leg.filledQty, delta);
    if (delta > 0) leadMisses = 0;
    if (closed) step.lead = null;
    syncFollow(job, step, leg);
    deps.jobs.write(job);
    if (!closed) await deps.sleep(POLL_MS);
  };

  const touchMoved = async (perp: StepPerp, rule: SliceRule, price: string | null): Promise<boolean> => {
    const now = await priceFor(deps, perp, rule, true);
    if (!now || price === null) return false;
    return perp.side === 'BUY' ? Number(now.price) > Number(price) : Number(now.price) < Number(price);
  };

  const runLead = async (step: Step, leg: RealizeJobLeg, perp: StepPerp, rule: SliceRule, open: boolean): Promise<void> => {
    const order = step.lead as PerpOrder;
    const cut = step.cut ?? null;
    if (order.venueId === null) {
      const found = await findOrder(step, perp, order.text);
      if (found === undefined) return halt(HALT_TEXT.unconfirmed);
      if (found === null) {
        if (order.poc && cut) cut.ioc = true;
        step.lead = null;
      } else order.venueId = found;
      deps.jobs.write(job);
      if (found === null) leadMissed(HALT_TEXT.unconfirmed);
      return;
    }
    const venueId = order.venueId;
    const body = await readOrder(crossEx(), venueId);
    if (!body) return deps.sleep(POLL_MS);
    const { delta, closed } = creditOrder(job, order, body, leg);
    leg.filledQty = addQty(leg.filledQty, delta);
    if (delta > 0) leadMisses = 0;
    if (closed) {
      step.lead = null;
      const pocRefused = order.poc && order.credited === 0;
      if (pocRefused && cut) cut.ioc = true;
      syncFollow(job, step, leg);
      deps.jobs.write(job);
      if (!order.poc && order.credited === 0 && !leadMissed(HALT_TEXT.nothingFilled)) await deps.sleep(REOPEN_FIRST_WAIT_MS);
      return;
    }
    syncFollow(job, step, leg);
    deps.jobs.write(job);
    const timedOut = cut !== null && deps.now() - cut.at >= MAKER_REST_MS;
    const stale = deps.now() - order.sentAt >= MAKER_REPEG_MS && (await touchMoved(perp, rule, order.price));
    if (open || delta > 0 || timedOut || stale) {
      if (timedOut && cut) cut.ioc = true;
      return cancelLead(step, leg, order as PerpOrder & { venueId: string });
    }
    await deps.sleep(POLL_MS);
  };

  const startSlice = async (step: Step, leg: RealizeJobLeg, perp: StepPerp, rule: SliceRule): Promise<void> => {
    const priced = await priceFor(deps, perp, rule, false);
    if (!priced) return deps.sleep(POLL_MS);
    const slice = job.slice ?? { index: 1, count: 1, sizeUsd: 0 };
    const firstEver = step.cut === null && job.steps.findIndex((candidate) => candidate.name === SLICE_STEP) === job.steps.indexOf(step);
    const left = addQty(leg.qty, -leg.filledQty);
    const minQty = minQtyOf(rule.limits, rule.lot, priced.mid);
    const qtys = sliceQtys(left, slice.sizeUsd > 0 ? slice.sizeUsd / priced.mid : 0, minQty, rule.lot);
    if (!firstEver) slice.index += 1;
    if (firstEver || slice.qty === undefined) slice.qty = qtys[0] ?? 0;
    slice.count = Math.max(slice.count, slice.index - 1 + qtys.length);
    job.slice = slice;
    step.cut = { qty: qtys[0] ?? 0, from: leg.filledQty, at: deps.now(), ioc: job.exec === 'market' };
    deps.jobs.write(job);
  };

  const sendLead = async (step: Step, leg: RealizeJobLeg, perp: StepPerp, rule: SliceRule): Promise<void> => {
    const cut = step.cut as NonNullable<Step['cut']>;
    const poc = job.exec === 'maker' && !cut.ioc;
    const priced = await priceFor(deps, perp, rule, poc);
    if (!priced) return deps.sleep(POLL_MS);
    const restLots = lotsOf(addQty(cut.qty, -addQty(leg.filledQty, -cut.from)), rule.lot);
    const liveLots = lotsOf(addQty(leg.positionQty, -leg.filledQty), rule.lot);
    const sizeUsd = job.slice?.sizeUsd ?? 0;
    const capLots = sizeUsd > 0 ? Math.floor(sizeUsd / priced.mid / Number(rule.lot) + 1e-9) : Number.POSITIVE_INFINITY;
    const minLots = Math.ceil(minQtyOf(rule.limits, rule.lot, priced.mid) / Number(rule.lot) - 1e-9);
    const wanted = Math.min(restLots, liveLots);
    const lots = wanted > capLots && wanted - capLots >= minLots ? capLots : wanted;
    if (lots <= 0) {
      cut.qty = addQty(leg.filledQty, -cut.from);
      deps.jobs.write(job);
      return;
    }
    const entry = job.kind === 'realize' ? await entryOf(leg.symbol) : null;
    job.tagCount += 1;
    const order: PerpOrder = { text: tagFor(job.id, job.tagCount), venueId: null, sentAt: deps.now(), credited: 0, poc, price: priced.price, side: perp.side, mid: priced.mid, entry };
    step.lead = order;
    deps.jobs.write(job);
    try {
      order.venueId = await placePerp(crossEx(), perp, order.text, qtyText(lots, rule.lot), { kind: poc ? 'poc' : 'ioc', price: priced.price });
      rateLimits = 0;
      deps.jobs.write(job);
    } catch (err) {
      const c = classifyGateError(err);
      rateLimits = c.category === 'rate-limited' ? rateLimits + 1 : 0;
      const definite = isRefusal(c) || c.category === 'rate-limited' || c.category === 'post-only-would-cross';
      if (!definite) return deps.sleep(POLL_MS);
      step.lead = null;
      deps.jobs.write(job);
      if (c.category === 'rate-limited') {
        if (rateLimits >= RATE_LIMIT_HALT_AFTER) return halt(HALT_TEXT.rateLimited);
        return deps.sleep(Math.min(REOPEN_FIRST_WAIT_MS * 2 ** (rateLimits - 1), REOPEN_MAX_WAIT_MS));
      }
      if (poc && (c.category === 'post-only-would-cross' || POC_REJECT.test(c.label ?? '') || isRefusal(c))) {
        cut.ioc = true;
        deps.jobs.write(job);
        return;
      }
      if (c.category === 'auth') return halt(REOPEN_HALT.tradePermission);
      halt(haltReasonFor(err));
    }
  };

  const entryOf = async (symbol: string): Promise<number | null> => {
    const held = ((await crossEx().listCrossexPositions()).body ?? []).find((position) => position.symbol === symbol);
    return positiveOf(held?.entryPrice) || null;
  };

  const runSlices = async (step: Step, perp: StepPerp, leg: RealizeJobLeg): Promise<void> => {
    const follow = step.follow;
    if (!follow) return halt(`unknown step ${step.name}`);
    try {
      const rule = await sliceRule(deps, perp.symbol);
      const followRule = follow.symbol === perp.symbol ? rule : await sliceRule(deps, follow.symbol);
      const openQty = openFollowOf(leg, step);
      const openLots = lotsOf(openQty, followRule.lot) > 0;
      const known = Number(step.lead?.price ?? step.hedge?.price ?? 0);
      const mark = known > 0 || !openLots ? known : ((await priceFor(deps, follow, followRule, false))?.mid ?? 0);
      const followMin = mark > 0 ? minQtyOf(followRule.limits, followRule.lot, mark) : positiveOf(followRule.limits.minSize);
      const leadLeft = Math.min(lotsOf(addQty(leg.qty, -leg.filledQty), rule.lot), lotsOf(addQty(leg.positionQty, -leg.filledQty), rule.lot)) > 0;
      const open = openLots && (openQty >= followMin - 1e-12 || !leadLeft);
      if (!step.lead && !step.hedge) {
        const queued = deps.takeFix?.();
        if (queued) {
          if (!open) return queued.done(job);
          return await applyFix(deps, job, queued.action).then(queued.done, queued.fail);
        }
      }
      if (step.lead) return await runLead(step, leg, perp, rule, open);
      if (open || step.hedge) return await runFollow(step, leg, follow, followRule);
      const cut = step.cut ?? null;
      const sliceDone = cut !== null && lotsOf(addQty(addQty(leg.filledQty, -cut.from), -cut.qty), rule.lot) >= 0;
      if (cut !== null && !sliceDone) return await sendLead(step, leg, perp, rule);
      if (cut !== null && job.kind === 'delever') job.imUsedNow = (await readImUsed(deps)) ?? job.imUsedNow;
      if (cut !== null && job.pauseRequested) return pauseNow();
      const leftLots = lotsOf(addQty(leg.qty, -leg.filledQty), rule.lot);
      const liveLots = lotsOf(addQty(leg.positionQty, -leg.filledQty), rule.lot);
      if (Math.min(leftLots, liveLots) <= 0) {
        syncFollow(job, step, leg);
        return finish(step, step.qty ?? 0, step.from);
      }
      await startSlice(step, leg, perp, rule);
      if (step.cut && !(step.cut.qty > 0)) {
        step.cut = null;
        return finish(step, step.qty ?? 0, step.from);
      }
    } catch (err) {
      const c = classifyGateError(err);
      if (c.retryable) return deps.sleep(POLL_MS);
      if (c.category === 'auth') return halt(REOPEN_HALT.tradePermission);
      halt(haltReasonFor(err));
    }
  };

  const runBoros = async (step: Step): Promise<void> => {
    try {
      const left = await closeBorosRest(deps, job);
      if (left > 0) return halt(borosPartText(left), 'boros');
      finish(step, 0, step.from);
    } catch (err) {
      halt(err instanceof BorosWaitError || (err instanceof Error && err.message === BOROS_MISSING_TEXT) ? (err as Error).message : haltReasonFor(err), 'boros');
    }
  };

  if (job.status === 'running' && (job.paused || job.haltKind)) {
    job.paused = false;
    job.haltKind = null;
    deps.jobs.write(job);
  }

  try {
    while (job.status === 'running') {
      const step = job.steps[job.stepIndex];
      const spec: StepSpec | undefined = STEPS[step.name as StepName];
      if (!spec) {
        halt(`unknown step ${step.name}`);
        continue;
      }
      if (step.startedAt === null) {
        step.startedAt = deps.now();
        step.status = 'running';
        deps.jobs.write(job);
      }
      const longRunning = step.name === 'Reopen' || step.name === SLICE_STEP || spec.kind === 'boros';
      if (!longRunning && deps.now() - step.startedAt > timeoutFor(spec)) {
        halt(HALT_TEXT.timeout);
        continue;
      }
      if (spec.kind === 'boros') {
        await runBoros(step);
        continue;
      }
      if (spec.kind === 'perp') {
        const leg = legOf(step);
        if (!step.perp || !leg) halt(`unknown step ${step.name}`);
        else if (step.name === SLICE_STEP) await runSlices(step, step.perp, leg);
        else if (step.name === 'Close') await runClose(step, step.perp, leg);
        else await runReopen(step, step.perp, leg);
        continue;
      }
      let phase: 'poll' | 'lookup' | 'read' | 'send' = 'poll';
      let amount: number | null = null;
      quoting = false;
      try {
        if (step.venueId !== null) {
          await poll(step, spec, step.venueId);
          if (job.status === 'running' && step.status !== 'done') await deps.sleep(POLL_MS);
          continue;
        }
        const key = spec.kind === 'convert' ? step.quoteId : step.text;
        if (step.text !== null && key !== null) {
          phase = 'lookup';
          const found = (await lookUpInWindow(deps, () => lookup(spec, key))) ?? (await sweep(step, spec, key));
          if (found === undefined) {
            halt(HALT_TEXT.unconfirmed);
            continue;
          }
          if (found !== null) {
            step.venueId = found;
            deps.jobs.write(job);
            continue;
          }
          if (retryPastReopen(step)) {
            finish(step, 0, job.fundsAt);
            continue;
          }
          if (step.sentAt !== undefined) {
            if (!reopenAhead(HALT_TEXT.notListed)) delete step.sentAt;
            halt(HALT_TEXT.notListed);
            continue;
          }
        }
        if (deps.pollOnly && !reopenOf(job.stepIndex)) {
          halt(HALT_TEXT.restart, 'restart');
          continue;
        }
        phase = 'read';
        amount = await prepare(step);
        if (amount === null) continue;
        if (spec.kind === 'transfer' && !isSendable(amount)) {
          halt(HALT_TEXT.cashTooLow);
          continue;
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
        if (phase === 'send' && (isRefusal(c) || c.category === 'rate-limited')) {
          delete step.sentAt;
          // Gate refused the Convert, so the quoted amount never landed.
          if (spec.kind === 'convert') step.qty = null;
          deps.jobs.write(job);
        }
        // A rate limit at send stops the run, so the trader sees it and Gate
        // is not asked again each second. The tag and quote id stay, so Resume
        // looks the send up before it sends again. A refused quote means the
        // day's 100 Convert quotes are used up.
        if (phase === 'send' && c.category === 'rate-limited') {
          halt(quoting ? HALT_TEXT.quotesUsed : HALT_TEXT.rateLimited);
        } else if (c.retryable || (phase === 'poll' && notFound)) {
          await deps.sleep(POLL_MS);
        } else if (phase !== 'send' || isRefusal(c)) {
          if (phase === 'send') step.quoteId = null;
          halt(
            spec.kind === 'transfer' && amount !== null && isSpotShortfall(spec.from, c)
              ? spotShortfallFailText(refusalReason(err), spec.coin, amount)
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
    job.haltKind = hedgeOpen() ? 'not-hedged' : 'other';
    try {
      deps.jobs.write(job);
    } catch {}
    deps.onHalt(job);
    deps.onDone?.();
  }
  if (job.status === 'done' && job.kind === 'delever') {
    job.imUsedEnd = (await readImUsed(deps)) ?? job.imUsedEnd;
    deps.jobs.write(job);
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
    deps.onDone?.();
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
      if (classified.category === 'rate-limited') {
        end('failed', null, HALT_TEXT.transferRateLimited);
        return;
      }
      if (isRefusal(classified)) {
        if (isSpotShortfall(transfer.from, classified)) {
          end('failed', null, spotShortfallFailText(refusalReason(err), transfer.coin, transfer.amount));
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
