import { CrossexOrderRequest, type CrossexOrder, type CrossexTransferRecord } from 'gate-api';
import { prettyVenue } from '../../web/src/lib/fmt';
import type { Clients } from '../core/clients';
import { classifyGateError, CoreError, refusalReason, type ClassifiedError } from '../core/errors';
import { DEFAULT_STEP, floorDecimalString, floorToStep, parseSymbol, roundToStep, stripZeros } from '../core/numbers';
import { fetchDeepBook, touchOf, type NormalizedBook } from '../core/estimate/books';
import { sliceQtys, twapSliceQty } from '../core/rebalance/slices';
import { PREFLIGHT_MARGIN_BUFFER, TAKER_FEE_RESERVE } from '../core/preflight';
import { takerAfterCapSec } from '../core/twap';
import type { DealRequest } from '../engine/create';
import type { Store } from '../engine/db';
import { hasMarginRefusalLabel, project } from '../engine/decide';
import { commands, decodeStatus } from '../engine/loop';
import { TUNING, type PairMode, type PairRow } from '../engine/types';
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
import { TTL, type TtlCache } from './cache';
import { borosShareOf, MAKER_FEE_BP, markOpenGap, runTwap, sliceStepBehind, TAKER_FEE_BP, type TwapRunDeps, unwindTargetOf } from './twapRun';
import {
  ADD_BACK_FIRST,
  addBackPartText,
  addBackRowsOf,
  restGapOf,
  asRealize,
  BOROS_STEP,
  borosPartText,
  borosWaitText,
  childIdFor,
  FIX_UNCONFIRMED,
  MAKER_REST_MS,
  RETRY_CONVERT_CAP,
  SLICE_STEP,
  type AddBack,
  type FixAction,
  type PerpOrder,
  convertSteps,
  HALT_TEXT,
  haltReasonFor,
  isChildOf,
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
  type JobFollow,
  type Step,
  type StepName,
  type StepPerp,
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
  twap?: TwapRunDeps;
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
  collateralUsd?: (marketId: number) => Promise<number | null>;
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
export const QUOTE_RECHECK_MS = 60_000;
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
const RETRY_CONVERT_HEADROOM = 1.05;

const lotsOf = (qty: number, lot: string): number => Math.round(qty / Number(lot));
export const lotsDownOf = (qty: number, lot: string): number => Math.round(Number(roundToStep(qty, lot, 'down')) / Number(lot));

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

type SliceRule = { lot: string; tick: string; limits: PerpRule & { maxMarketSize?: string; maxLimitSize?: string } };
type Engine = NonNullable<RunnerDeps['twap']>;
type ChildLeg = Pick<StepPerp, 'symbol' | 'side' | 'reduceOnly'>;

const QTY_SCALE = 1e8;
const addQty = (a: number, b: number): number => Math.round((a + b) * QTY_SCALE) / QTY_SCALE;
const qtyText = (lots: number, lot: string): string => stripZeros(roundToStep(lots * Number(lot), lot, 'nearest'));
const ENDED: readonly PairMode[] = ['DONE', 'HALTED'];
const ENGINE_MISSING = 'The order engine is not running. Restart the app, then resume.';
const BOROS_MIN_USD = 10;

function engineOf(deps: RunnerDeps): Engine {
  if (!deps.twap) throw new CoreError(ENGINE_MISSING, 'validation');
  return deps.twap;
}

const isLive = (pair: PairRow | null): boolean => pair !== null && !ENDED.includes(pair.mode);

function filledOf(store: Store, pair: PairRow): { a: number; b: number } {
  const projection = project(pair, store.listOrders(pair.id));
  return { a: positiveOf(projection.aFilled), b: positiveOf(projection.bFilled) };
}

const childLeg = (leg: ChildLeg): DealRequest['a'] => ({ symbol: leg.symbol, side: leg.side, ...(leg.reduceOnly ? { reduceOnly: true } : {}) });

const oneLegChild = (id: string, leg: ChildLeg, qty: string): DealRequest => ({ id, a: childLeg(leg), b: null, qty, execution: 'taker' });

const isBelowMinimum = (err: unknown): boolean =>
  classifyGateError(err).category === 'size-too-small' || (err instanceof CoreError && /minimum (size|order value)/.test(err.message));

const refusedAsTooSmall = (store: Store, child: PairRow): boolean =>
  child.b === null &&
  store
    .listOrders(child.id)
    .some((order) => order.leg === 'A' && order.closeReason?.startsWith('rejected:') && isBelowMinimum({ response: { data: { label: order.closeReason.slice('rejected:'.length) } } }));

function nextChildId(store: Store, jobId: string, slice: number): string {
  let k = 1;
  while (store.getPair(childIdFor(jobId, slice, k))) k += 1;
  return childIdFor(jobId, slice, k);
}

const opposite = (side: 'BUY' | 'SELL'): 'BUY' | 'SELL' => (side === 'BUY' ? 'SELL' : 'BUY');

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

async function midOf(deps: RunnerDeps, symbol: string): Promise<number | null> {
  const touch = touchOf(await bookOf(deps, symbol).catch(() => null));
  return touch && touch.mid > 0 ? touch.mid : null;
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

const wholeLegOf = (job: Job, symbol: string): NonNullable<Job['delever']>['legs'][number] | null =>
  job.delever?.legs.find((row) => row.symbol === symbol && row.closeAll === true) ?? null;

function followPlannedOf(job: Job, step: Step, leg: RealizeJobLeg): number {
  const whole = job.kind === 'delever' && step.follow ? wholeLegOf(job, step.follow.symbol) : null;
  return whole ? whole.before : leg.qty;
}

function borosTargets(job: Job): { row: NonNullable<Job['delever']>['boros'][number]; target: number }[] {
  const leg = job.realize?.legs[0];
  const step = job.steps.find((candidate) => candidate.name === SLICE_STEP);
  if (!job.delever || !leg || !step) return [];
  const legFilled: [number, number] = [leg.filledQty, step.qty ?? 0];
  const legPlanned: [number, number] = [leg.qty, followPlannedOf(job, step, leg)];
  return job.delever.boros.map((row) => {
    const closeSize = Math.abs(row.before - row.after);
    return { row, target: Math.min(closeSize, borosShareOf({ closeSize, legFilled, legPlanned })) };
  });
}

function setBorosGap(job: Job): void {
  if (!job.delever) return;
  job.borosGapYu = borosTargets(job).reduce((total, { row, target }) => total + Math.max(0, target - row.closed), 0);
}

const BOROS_MISSING_TEXT = 'The app has no Boros wallet to close the Boros share with.';
const BOROS_DUST_YU = 1e-9;
export const BOROS_LATE_SEND_MS = 10 * 60_000;

class BorosWaitError extends CoreError {}

async function closeBorosRest(deps: RunnerDeps, job: Job, usdPerYu: Map<number, number> | null = null): Promise<number> {
  let short = 0;
  try {
    for (const { row, target } of borosTargets(job)) {
      const rest = target - row.closed;
      if (!(rest > BOROS_DUST_YU)) continue;
      if (usdPerYu !== null && rest * (usdPerYu.get(row.marketId) ?? Number.POSITIVE_INFINITY) <= BOROS_MIN_USD) continue;
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
      short += Math.max(0, target - row.closed);
      deps.jobs.write(job);
    }
  } finally {
    job.borosLeftYu = borosTargets(job).reduce((total, { row, target }) => total + Math.max(0, target - row.closed), 0);
    if (job.borosLeftYu <= BOROS_DUST_YU) job.borosLeftYu = 0;
    setBorosGap(job);
    deps.jobs.write(job);
  }
  if (usdPerYu !== null) return short > BOROS_DUST_YU ? short : 0;
  return job.borosLeftYu;
}

export async function cancelRestingLead(deps: RunnerDeps, job: Job): Promise<void> {
  const step = job.steps[job.stepIndex];
  const id = step?.name === SLICE_STEP ? (step.lead?.text ?? null) : null;
  const child = id !== null && deps.twap ? deps.twap.store.getPair(id) : null;
  if (deps.twap && child && isLive(child) && child.mode !== 'HALTED') {
    commands.stop(deps.twap.store, child.id);
    deps.twap.engineWake();
  }
  const sliceDone = !isLive(child);
  job.status = 'halted';
  job.paused = job.pauseRequested && sliceDone;
  if (job.paused) job.pauseRequested = false;
  job.haltReason = job.paused ? null : HALT_TEXT.restart;
  job.haltKind = job.paused ? null : 'restart';
  if (deps.twap) markOpenGap(deps.twap.store, job);
  setBorosGap(job);
  deps.jobs.write(job);
}

const FIX_WAIT_MS = STEP_TIMEOUT_MS;
const HEDGE_HELD = Number.MAX_SAFE_INTEGER;

async function waitEnded(deps: RunnerDeps, store: Store, id: string): Promise<PairRow> {
  const start = deps.now();
  for (;;) {
    const pair = store.getPair(id);
    if (!pair) throw new CoreError(FIX_UNCONFIRMED, 'validation');
    if (!isLive(pair)) return pair;
    if (isWalledStop(store, pair)) {
      haltWalled(store, pair);
      return store.getPair(id) ?? pair;
    }
    if (deps.now() - start > FIX_WAIT_MS) {
      if (pair.mode === 'STOPPING' && pair.b !== null && pair.b.reduceOnly !== true) haltWalled(store, pair);
      throw new CoreError(FIX_UNCONFIRMED, 'validation');
    }
    await deps.sleep(POLL_MS);
  }
}

async function sendOneLeg(deps: RunnerDeps, id: string, leg: ChildLeg, qty: string): Promise<PairRow> {
  const engine = engineOf(deps);
  if (!engine.store.getPair(id)) {
    await engine.createChild(oneLegChild(id, leg, qty));
    engine.engineWake();
  }
  return waitEnded(deps, engine.store, id);
}

async function addBackLeg(
  deps: RunnerDeps,
  job: Job,
  perp: NonNullable<Job['delever']>['legs'][number],
  row: AddBack['legs'][number],
  qty: number,
): Promise<void> {
  const rule = await sliceRule(deps, perp.symbol);
  if (!row.order) {
    const lots = lotsDownOf(qty, rule.lot) - lotsOf(row.filled, rule.lot);
    if (lots <= 0) return;
    job.tagCount += 1;
    row.order = { text: `${job.id}-f${job.tagCount}`, venueId: null, sentAt: deps.now(), credited: 0, poc: false, price: null };
    deps.jobs.write(job);
  }
  const order = row.order;
  const side = perp.side === 'SHORT' ? 'SELL' : 'BUY';
  let ended: PairRow;
  try {
    const lots = Math.max(1, lotsDownOf(qty, rule.lot) - lotsOf(row.filled, rule.lot));
    ended = await sendOneLeg(deps, order.text, { symbol: perp.symbol, side, reduceOnly: false }, qtyText(lots, rule.lot));
  } catch (err) {
    if (!engineOf(deps).store.getPair(order.text)) row.order = null;
    deps.jobs.write(job);
    throw err;
  }
  row.filled = addQty(row.filled, filledOf(engineOf(deps).store, ended).a);
  row.order = null;
  deps.jobs.write(job);
  if (filledOf(engineOf(deps).store, ended).a === 0) throw new Error(`Gate filled none of the ${perp.base} order. Try again.`);
}

export async function endHaltedChildren(deps: RunnerDeps, job: Job): Promise<void> {
  if (!deps.twap) return;
  const { store } = deps.twap;
  const halted = store.listPairs({ activeOnly: true }).filter((pair) => pair.mode === 'HALTED' && isChildOf(job.id, pair.id));
  for (const pair of halted) {
    await heldSettled(deps, pair);
    store.updatePair(pair.id, { mode: 'DONE' });
  }
}

export async function settleAddBack(deps: RunnerDeps, job: Job): Promise<string[]> {
  const unread: string[] = [];
  for (const row of job.steps[job.stepIndex]?.addBack?.legs ?? []) {
    const order = row.order;
    if (!order) continue;
    const pair = deps.twap?.store.getPair(order.text) ?? null;
    if (!pair) {
      if (deps.now() - order.sentAt < LOOKUP_WINDOW_MS) throw new CoreError(FIX_UNCONFIRMED, 'validation');
      unread.push(row.symbol);
    } else {
      if (isLive(pair)) throw new CoreError(FIX_UNCONFIRMED, 'validation');
      row.filled = addQty(row.filled, filledOf(engineOf(deps).store, pair).a);
    }
    row.order = null;
    deps.jobs.write(job);
  }
  return unread;
}

function haltedChildOf(deps: RunnerDeps, job: Job): PairRow | null {
  if (!deps.twap) return null;
  const step = sliceStepBehind(job);
  const id = job.kind === 'twap' && job.twap ? childIdFor(job.id, job.twap.sliceIndex, 1) : (step?.lead?.text ?? null);
  const pair = id !== null ? deps.twap.store.getPair(id) : null;
  return pair?.mode === 'HALTED' ? pair : null;
}

function skipRetryConverts(deps: RunnerDeps, job: Job): void {
  const step = sliceStepBehind(job);
  if (!step || step === job.steps[job.stepIndex]) return;
  const between = job.steps.slice(job.stepIndex, job.steps.indexOf(step));
  if (between.some((convert) => convert.quoteId !== null || convert.venueId !== null)) return;
  for (const convert of between) {
    convert.status = 'done';
    convert.qty ??= 0;
    convert.doneAt = deps.now();
    delete convert.sentAt;
  }
  job.stepIndex = job.steps.indexOf(step);
}

const isWalledStop = (store: Store, pair: PairRow): boolean =>
  pair.mode === 'STOPPING' &&
  pair.b !== null &&
  pair.b.reduceOnly !== true &&
  pair.hedgeRejectStreak >= TUNING.HEDGE_REJECT_HALT &&
  !project(pair, store.listOrders(pair.id)).anyPending;

function haltWalled(store: Store, pair: PairRow): void {
  const lastHedge = store.listOrders(pair.id).filter((order) => order.leg === 'B').at(-1);
  store.updatePair(pair.id, {
    mode: 'HALTED',
    haltKind: lastHedge && hasMarginRefusalLabel(lastHedge) ? 'hedge-margin' : null,
  });
}


function creditSliceChild(job: Job, store: Store, pair: PairRow): void {
  const step = job.steps[job.stepIndex];
  const leg = legFor(job, step);
  const perp = step?.perp;
  if (!step || !leg || !perp || step.lead?.text !== pair.id) return;
  const filled = filledOf(store, pair);
  const onLead = pair.a.contract === perp.symbol && pair.a.side === perp.side;
  const leadNow = onLead ? filled.a : 0;
  const followNow = onLead ? filled.b : filled.a;
  leg.filledQty = addQty(leg.filledQty, leadNow - step.lead.credited);
  step.lead.credited = leadNow;
  const hedge = step.hedge ?? { ...step.lead, credited: 0 };
  step.hedge = hedge;
  step.qty = addQty(step.qty ?? 0, followNow - hedge.credited);
  hedge.credited = followNow;
}

function resumeRun(job: Job): void {
  job.status = 'running';
  job.paused = false;
  job.haltReason = null;
  job.haltKind = null;
  job.notHedgedQty = 0;
  job.follow = null;
  job.unwindTarget = null;
}

async function heldSettled(deps: RunnerDeps, halted: PairRow): Promise<PairRow> {
  const engine = engineOf(deps);
  const start = deps.now();
  for (;;) {
    const pair = engine.store.getPair(halted.id);
    if (!pair) throw new CoreError(FIX_UNCONFIRMED, 'validation');
    if (pair.hedgeNotBefore !== HEDGE_HELD) engine.store.updatePair(halted.id, { hedgeNotBefore: HEDGE_HELD });
    if (project(pair, engine.store.listOrders(halted.id)).allSettled) return pair;
    if (deps.now() - start > FIX_WAIT_MS) throw new CoreError(FIX_UNCONFIRMED, 'validation');
    engine.engineWake();
    await deps.sleep(POLL_MS);
  }
}

async function closeGap(deps: RunnerDeps, job: Job, target: JobFollow, qty: number): Promise<{ done: number; lot: number }> {
  const rule = await sliceRule(deps, target.symbol);
  const lots = lotsDownOf(qty, rule.lot);
  if (lots <= 0) return { done: 0, lot: Number(rule.lot) };
  const ended = await sendOneLeg(deps, `${job.id}-g${job.tagCount}`, { symbol: target.symbol, side: target.side, reduceOnly: target.reduceOnly }, qtyText(lots, rule.lot));
  job.tagCount += 1;
  return { done: filledOf(engineOf(deps).store, ended).a, lot: Number(rule.lot) };
}

function settleGap(job: Job, gap: number, done: number, lot: number): boolean {
  const rest = Math.max(0, addQty(gap, -done));
  if (rest >= lot) {
    job.status = 'halted';
    job.notHedgedQty = rest;
    if (job.follow) job.follow = { ...job.follow, qty: rest };
    if (job.unwindTarget) job.unwindTarget = { ...job.unwindTarget, qty: rest };
    return false;
  }
  job.notHedgedQty = 0;
  job.follow = null;
  job.unwindTarget = null;
  return true;
}

async function unwindGap(deps: RunnerDeps, job: Job, halted: PairRow | null): Promise<Job> {
  const engine = engineOf(deps);
  const step = job.steps[job.stepIndex];
  const leg = legFor(job, step);
  if (!step || !leg) throw new CoreError(FIX_UNCONFIRMED, 'validation');
  let gap = job.notHedgedQty;
  let target = job.unwindTarget ?? null;
  if (halted) {
    if (!unwindTargetOf(job, step, halted, gap)) throw new CoreError(REOPEN_HALT.noHedgePerp, 'validation');
    const settled = await heldSettled(deps, halted);
    creditSliceChild(job, engine.store, settled);
    const filled = filledOf(engine.store, settled);
    gap = Math.max(0, addQty(filled.a, -filled.b));
    target = unwindTargetOf(job, step, settled, gap);
    engine.store.updatePair(halted.id, { mode: 'DONE' });
    job.notHedgedQty = gap;
    job.unwindTarget = target;
    deps.jobs.write(job);
  }
  if (!target) throw new CoreError(REOPEN_HALT.noHedgePerp, 'validation');
  const { done, lot } = await closeGap(deps, job, target, gap);
  if (job.kind === 'realize') step.qty = addQty(step.qty ?? 0, done);
  else leg.filledQty = Math.max(0, addQty(leg.filledQty, -done));
  if (settleGap(job, gap, done, lot)) {
    job.paused = true;
    job.pauseRequested = false;
    job.haltReason = null;
    job.haltKind = null;
  }
  deps.jobs.write(job);
  return job;
}

async function followGap(deps: RunnerDeps, job: Job): Promise<Job> {
  const step = job.steps[job.stepIndex];
  const follow = job.follow;
  if (!step || !follow) throw new CoreError(FIX_UNCONFIRMED, 'validation');
  const gap = job.notHedgedQty;
  const { done, lot } = await closeGap(deps, job, follow, gap);
  step.qty = addQty(step.qty ?? 0, done);
  if (settleGap(job, gap, done, lot)) resumeRun(job);
  deps.jobs.write(job);
  return job;
}

async function unwindChild(deps: RunnerDeps, job: Job, halted: PairRow): Promise<PairRow> {
  const engine = engineOf(deps);
  const start = deps.now();
  let settled = halted;
  for (;;) {
    const pair = engine.store.getPair(halted.id);
    if (!pair) throw new CoreError(FIX_UNCONFIRMED, 'validation');
    if (pair.hedgeNotBefore !== HEDGE_HELD) engine.store.updatePair(halted.id, { hedgeNotBefore: HEDGE_HELD });
    settled = pair;
    if (project(pair, engine.store.listOrders(halted.id)).allSettled) break;
    if (deps.now() - start > FIX_WAIT_MS) throw new CoreError(FIX_UNCONFIRMED, 'validation');
    engine.engineWake();
    await deps.sleep(POLL_MS);
  }
  const filled = filledOf(engine.store, settled);
  const rule = await sliceRule(deps, halted.a.contract);
  const lots = lotsDownOf(Math.max(0, addQty(filled.a, -filled.b)), rule.lot);
  if (lots > 0) {
    const step = job.steps[job.stepIndex];
    const id = job.kind === 'twap' && job.twap ? `${job.id}-f${job.twap.sliceIndex}` : nextChildId(engine.store, job.id, job.slice?.index ?? 1);
    const ended = await sendOneLeg(deps, id, { symbol: halted.a.contract, side: opposite(halted.a.side), reduceOnly: halted.a.reduceOnly !== true }, qtyText(lots, rule.lot));
    const leg = legFor(job, step);
    if (step?.name === SLICE_STEP && leg) leg.filledQty = Math.max(0, addQty(leg.filledQty, -filledOf(engine.store, ended).a));
  }
  engine.store.updatePair(halted.id, { mode: 'DONE' });
  return engine.store.getPair(halted.id) ?? settled;
}

export async function applyFix(deps: RunnerDeps, job: Job, action: FixAction | 'unwind'): Promise<Job> {
  const step = job.steps[job.stepIndex];
  if (action === 'boros-retry') {
    if (step?.addBack && job.status === 'halted') throw new CoreError(ADD_BACK_FIRST, 'validation');
    if (job.delever && (job.status === 'abandoned' || step?.name === SLICE_STEP)) {
      const left = await closeBorosRest(deps, job);
      const shareDone = borosTargets(job).every(({ row, target }) => target - row.closed <= BOROS_DUST_YU || row.sent);
      if (job.status === 'halted' && job.haltKind === 'boros' && step?.name === SLICE_STEP && (left === 0 || shareDone)) resumeRun(job);
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
  const halted = haltedChildOf(deps, job);
  if (job.kind !== 'twap') {
    if (!halted && !(job.notHedgedQty > 0)) return job;
    skipRetryConverts(deps, job);
    if (job.steps[job.stepIndex]?.name !== SLICE_STEP) throw new CoreError(FIX_UNCONFIRMED, 'validation');
    if (action === 'unwind') return unwindGap(deps, job, halted);
    if (!halted) return followGap(deps, job);
  } else if (!halted) return job;
  const engine = engineOf(deps);
  if (action === 'unwind') {
    creditSliceChild(job, engine.store, await unwindChild(deps, job, halted));
    job.paused = true;
    job.pauseRequested = false;
    job.haltReason = null;
    job.haltKind = null;
    job.notHedgedQty = 0;
    job.follow = null;
    deps.jobs.write(job);
    return job;
  }
  commands.resumeAfterHalt(engine.store, halted.id);
  engine.engineWake();
  const ended = await waitEnded(deps, engine.store, halted.id);
  creditSliceChild(job, engine.store, ended);
  if (ended.mode === 'HALTED') {
    if (job.kind !== 'twap') markOpenGap(engine.store, job);
    deps.jobs.write(job);
    const refused = job.kind === 'twap' ? REOPEN_HALT.hedgeRefusedAgain : REOPEN_HALT.noCash;
    throw new CoreError(ended.haltKind === 'hedge-margin' ? refused : FIX_UNCONFIRMED, 'validation');
  }
  resumeRun(job);
  deps.jobs.write(job);
  return job;
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

async function runTwapJob(deps: RunnerDeps, job: Job): Promise<void> {
  if (!deps.twap) {
    job.status = 'halted';
    job.haltKind = 'error';
    job.haltReason = ENGINE_MISSING;
    deps.jobs.write(job);
    deps.onDone?.();
    return;
  }
  for (;;) {
    await runTwap(deps.twap, job);
    const fresh = deps.jobs.read();
    if (fresh?.id !== job.id || fresh.status !== 'running') break;
    await deps.sleep(POLL_MS);
  }
  deps.onDone?.();
}

export async function runJob(deps: RunnerDeps): Promise<void> {
  const job = deps.jobs.read();
  if (!job) return;
  if (job.kind === 'twap') return runTwapJob(deps, job);
  const crossEx = () => deps.clients().crossEx;

  const reopenOf = (index: number): Step | null => {
    if (!job.steps[index]?.name.startsWith('Convert')) return null;
    const next = job.steps.slice(index + 1).find((later) => !later.name.startsWith('Convert'));
    return next?.name === SLICE_STEP && job.steps[index].retry ? next : null;
  };

  const legOf = (step: Step): RealizeJobLeg | undefined =>
    job.realize?.legs.find((leg) => leg.symbol === step.perp?.symbol);

  const openOf = (leg: RealizeJobLeg, reopen: Step): number => leg.filledQty - (reopen.qty ?? 0);

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
    const reopen = reopenOf(job.stepIndex);
    const leg = reopen ? legOf(reopen) : undefined;
    return (reopen !== null && leg !== undefined && openOf(leg, reopen) > 0);
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
    if (deps.twap) markOpenGap(deps.twap.store, job);
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

  const trimRoute = async (missing: number): Promise<void> => {
    const start = job.steps.reduce((last, step, index) => (step.name === SLICE_STEP ? index : last), -1) + 1;
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

  const marginPerCoin = async (leg: RealizeJobLeg): Promise<number> => {
    const held = ((await crossEx().listCrossexPositions()).body ?? []).find((position) => position.symbol === leg.symbol);
    const qty = Math.abs(Number(held?.positionQty));
    const margin = Math.abs(Number(held?.initialMargin));
    return qty > 0 && margin > 0 ? margin / qty : 0;
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

  const feeBpOf = (step: Step): number => (job.exec === 'market' || step.cut?.taker === true ? 2 * TAKER_FEE_BP : MAKER_FEE_BP + TAKER_FEE_BP);

  let triedQty: number | null = null;

  const topUp = async (step: Step, leg: RealizeJobLeg): Promise<void> => {
    if (job.topUpPending) return halt(REOPEN_HALT.marginLow, 'margin');
    if (triedQty === null || (job.topUps ?? 0) >= RETRY_CONVERT_CAP) return halt(REOPEN_HALT.noCash, 'margin');
    const account = await readAccount(crossEx());
    if (account.borrow(poolWallet(CONVERT_TO[leg.pool])) === 0) return halt(REOPEN_HALT.noCash, 'margin');
    const cash = floorCents(Math.max(0, account.cash(poolWallet(leg.pool))));
    if (cash < HYPERLIQUID_MIN_USDC) return halt(REOPEN_HALT.noCash, 'margin');
    const mid = (await midOf(deps, leg.symbol)) ?? 0;
    const need = triedQty * ((await marginPerCoin(leg)) * (PREFLIGHT_MARGIN_BUFFER - 1) + 2 * mid * TAKER_FEE_RESERVE);
    const drain = (Math.max(0, addQty(leg.qty, -leg.filledQty)) * mid * feeBpOf(step)) / 10_000;
    const whole = ceilCents(((Math.max(0, need - account.available) + drain) / marginPerConvertUsdc) * RETRY_CONVERT_HEADROOM);
    const retry = { reason: 'margin' as const, convertAmount: Math.min(cash, Math.max(HYPERLIQUID_MIN_USDC, whole)) };
    job.topUpPending = true;
    job.topUps = (job.topUps ?? 0) + 1;
    step.retry = retry;
    const converts = asRealize(convertSteps(leg.pool, CONVERT_TO[leg.pool], retry.convertAmount)).map((convert) => ({ ...convert, retry }));
    job.steps.splice(job.steps.indexOf(step), 0, ...converts);
    deps.jobs.write(job);
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

  const checkQuotes = async (): Promise<boolean> => {
    const kinds = new Map<string, Step>();
    for (const step of job.steps) {
      const unsent = step.phase === 'realize' && step.status !== 'done' && !isSent(step);
      if (unsent && STEPS[step.name as StepName]?.kind === 'convert' && !kinds.has(convertSpec(step).symbol)) kinds.set(convertSpec(step).symbol, step);
    }
    if (kinds.size === 0) return true;
    const account = await readAccount(crossEx());
    for (const convert of kinds.values()) {
      const spec = convertSpec(convert);
      const wallet = spec.fromCoin === 'USDT' ? USDT_WALLET : poolWallet(spec.venue);
      const amount = Math.min(floorCents(convert.planned ?? 0), floorCents(Math.max(0, account.cash(wallet))));
      if (amount < HYPERLIQUID_MIN_USDC || (await hasQuoteLeft(convert, amount))) continue;
      await deps.sleep(QUOTE_RECHECK_MS);
      if (await hasQuoteLeft(convert, amount)) continue;
      halt(HALT_TEXT.quotesUsed);
      return false;
    }
    return true;
  };

  const mayStartSlice = async (step: Step, leg: RealizeJobLeg): Promise<boolean> => {
    if (await isCloseOnly(leg.symbol)) {
      halt(REOPEN_HALT.closeOnly(leg, openOf(leg, step)));
      return false;
    }
    if (step.cut !== null || job.quotesChecked) return true;
    const left = await checkQuotes();
    if (left) {
      job.quotesChecked = true;
      deps.jobs.write(job);
    }
    return left;
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

  const liveQtyOf = async (symbol: string, side: RealizeJobLeg['side']): Promise<number> => {
    const signed = Number(((await crossEx().listCrossexPositions()).body ?? []).find((position) => position.symbol === symbol)?.positionQty ?? 0);
    if (!Number.isFinite(signed)) throw new Error(`Gate sent no position size for ${symbol}`);
    return Math.max(0, side === 'SHORT' ? -signed : signed);
  };

  const wholeLotsOf = async (leg: RealizeJobLeg, lot: string, planned: number): Promise<number> => {
    const live = lotsDownOf(await liveQtyOf(leg.symbol, leg.side), lot);
    if (live >= planned) return planned;
    leg.positionQty = addQty(leg.filledQty, Number(qtyText(live, lot)));
    leg.qty = leg.positionQty;
    deps.jobs.write(job);
    return live;
  };

  const entryOf = async (symbol: string): Promise<number | null> => {
    const held = ((await crossEx().listCrossexPositions()).body ?? []).find((position) => position.symbol === symbol);
    return positiveOf(held?.entryPrice) || null;
  };

  const twap = job.kind === 'delever' || job.kind === 'realize' ? (job.deleverTwap ?? null) : null;
  const longWait = !!job.maker && (job.maker.takerAfterSec === null || job.maker.takerAfterSec > MAKER_REST_MS / 1000);

  const sliceRequest = (id: string, perp: StepPerp, follow: StepPerp, qty: string): DealRequest => {
    const base = { id, a: childLeg(perp), b: childLeg(follow), qty };
    if (job.exec === 'market') return { ...base, execution: 'taker' };
    return {
      ...base,
      execution: 'maker',
      pricePolicy: 'touch',
      timeoutSec: twap ? (twap.takerAfterSec === undefined ? takerAfterCapSec(twap.intervalSec) : twap.takerAfterSec) : job.maker ? job.maker.takerAfterSec : MAKER_REST_MS / 1000,
      ...(twap ? { deadlineCapSec: takerAfterCapSec(twap.intervalSec) } : {}),
      ...(twap ? (twap.repegBehindBp === undefined ? {} : { repegBehindBp: twap.repegBehindBp }) : job.maker ? { repegBehindBp: job.maker.repegBehindBp } : {}),
    };
  };

  const sendChild = async (step: Step, perp: StepPerp, req: DealRequest, mid: number, entry: number | null): Promise<void> => {
    const engine = engineOf(deps);
    const sentAt = deps.now();
    step.lead = { text: req.id, venueId: null, sentAt, credited: 0, poc: req.execution === 'maker', price: null, side: perp.side, mid, entry };
    step.hedge = { text: req.id, venueId: null, sentAt, credited: 0, poc: false, price: null, side: step.follow?.side, mid };
    deps.jobs.write(job);
    try {
      await engine.createChild(req);
    } catch (err) {
      if (!engine.store.getPair(req.id)) {
        step.lead = null;
        step.hedge = null;
        deps.jobs.write(job);
      }
      throw err;
    }
    engine.engineWake();
  };

  const costChild = async (step: Step, leg: RealizeJobLeg, pair: PairRow): Promise<void> => {
    const engine = engineOf(deps);
    const lead = step.lead as PerpOrder;
    const fees = await engine.readFees([pair.id]).catch(() => ({}) as Record<string, number>);
    const fee = Number.isFinite(fees[pair.id]) ? Math.abs(fees[pair.id]) : 0;
    const filled = filledOf(engine.store, pair);
    const mid = lead.mid ?? 0;
    const worse = (leg: 'A' | 'B', side: 'BUY' | 'SELL', qty: number): number => {
      const avg = positiveOf(engine.store.avgFillPrice(pair.id, leg) ?? '');
      if (!(avg > 0) || !(mid > 0)) return 0;
      return qty * Math.max(0, side === 'BUY' ? avg - mid : mid - avg);
    };
    const impact = worse('A', pair.a.side, filled.a) + (pair.b ? worse('B', pair.b.side, filled.b) : 0);
    job.feeSoFarUsd = nearestCents(job.feeSoFarUsd + fee);
    job.totalCostUsd = nearestCents((job.totalCostUsd ?? 0) + fee + impact);
    const avgA = positiveOf(engine.store.avgFillPrice(pair.id, 'A') ?? '');
    const entry = lead.entry ?? 0;
    if (avgA > 0 && entry > 0 && pair.a.contract === leg.symbol) {
      leg.realizedUsd = nearestCents(leg.realizedUsd + filled.a * (leg.side === 'SHORT' ? entry - avgA : avgA - entry));
    }
    step.lead = null;
    step.hedge = null;
    deps.jobs.write(job);
  };

  let resumeHalted = job.status === 'running' && Boolean(job.haltKind);

  const onHalted = async (step: Step, leg: RealizeJobLeg, child: PairRow): Promise<void> => {
    const engine = engineOf(deps);
    if (resumeHalted || (step.retry && job.kind === 'realize' && child.haltKind === 'hedge-margin')) {
      resumeHalted = false;
      step.retry = null;
      commands.resumeAfterHalt(engine.store, child.id);
      engine.engineWake();
      deps.jobs.write(job);
      return;
    }
    if (child.haltKind === 'hedge-margin' && job.kind === 'realize') return retryConvertCapped(step, leg);
    const slice = job.slice?.index ?? 1;
    if (child.haltKind === 'hedge-margin') {
      const hedge = prettyVenue(parseSymbol((child.b ?? child.a).contract).exchange);
      return halt(`${hedge} refused the hedge in slice ${slice}`, 'hedge-margin');
    }
    const reason = child.haltReason ?? `Slice ${slice} stopped on an error. Check the orders, then resume or stop.`;
    engine.store.alert('error', child.id, reason, deps.now());
    halt(reason, 'error');
  };

  const borosAfterSlice = async (): Promise<boolean> => {
    try {
      const usdPerYu = new Map<number, number>();
      for (const row of job.delever?.boros ?? []) {
        const price = await deps.boros?.collateralUsd?.(row.marketId).catch(() => null);
        usdPerYu.set(row.marketId, price && price > 0 ? price : Number.POSITIVE_INFINITY);
      }
      const short = await closeBorosRest(deps, job, usdPerYu);
      if (short > 0) {
        halt(borosPartText(short), 'boros');
        return false;
      }
      return true;
    } catch (err) {
      halt(err instanceof BorosWaitError || (err instanceof Error && err.message === BOROS_MISSING_TEXT) ? (err as Error).message : haltReasonFor(err), 'boros');
      return false;
    }
  };

  const sliceQtyOf = (step: Step, pairLeft: number, lot: string, rule: SliceRule, mid: number, capQty: number): { n: number; k: number; qty: number } => {
    const slice = job.slice ?? { index: 1, count: 1, sizeUsd: 0 };
    const firstEver = !step.cut && job.steps.findIndex((candidate) => candidate.name === SLICE_STEP) === job.steps.indexOf(step);
    const n = firstEver ? slice.index : slice.index + 1;
    const k = step.cut ? (step.cut.n ?? slice.index) + 1 : 1;
    const minQty = minQtyOf(rule.limits, lot, mid);
    if (twap) {
      const total = twap.legs?.find((row) => row.symbol === step.perp?.symbol)?.slices ?? twap.slices;
      slice.count = Math.max(twap.slices, n);
      return { n, k, qty: twapSliceQty(pairLeft, k, total, lot, minQty, capQty) };
    }
    const askedQty = Math.min(slice.sizeUsd > 0 ? slice.sizeUsd / mid : Infinity, capQty);
    const qtys = sliceQtys(pairLeft, Number.isFinite(askedQty) ? askedQty : 0, minQty, lot, capQty);
    slice.count = Math.max(slice.count, n - 1 + qtys.length);
    return { n, k, qty: qtys[0] ?? 0 };
  };

  const twapWaits = (step: Step): boolean => {
    if (!twap) return false;
    const last = step.cut ?? job.steps.slice(0, job.steps.indexOf(step)).filter((earlier) => earlier.name === SLICE_STEP && earlier.cut).at(-1)?.cut ?? null;
    return last !== null && deps.now() < last.at + twap.intervalSec * 1000;
  };

  const startSlice = async (step: Step, perp: StepPerp, follow: StepPerp, leg: RealizeJobLeg, pairLeft: number, lot: string, rule: SliceRule, mid: number, capQty: number): Promise<void> => {
    const { n, k, qty } = sliceQtyOf(step, pairLeft, lot, rule, mid, capQty);
    const lots = lotsDownOf(qty, lot) > 0 ? lotsDownOf(qty, lot) : lotsDownOf(pairLeft, lot);
    const slice = job.slice ?? { index: n, count: 1, sizeUsd: 0 };
    const before = { cut: step.cut ?? null, index: slice.index, qty: slice.qty };
    slice.index = n;
    if (!step.cut || slice.qty === undefined) slice.qty = qty;
    job.slice = slice;
    step.cut = { qty, from: leg.filledQty, at: deps.now(), ioc: job.exec === 'market', n: k };
    const entry = job.kind === 'realize' ? await entryOf(leg.symbol) : null;
    const req = sliceRequest(nextChildId(engineOf(deps).store, job.id, n), perp, follow, qtyText(lots, lot));
    triedQty = Number(qtyText(lots, lot));
    try {
      await sendChild(step, perp, req, mid, entry);
    } catch (err) {
      if (!step.lead) {
        step.cut = before.cut;
        slice.index = before.index;
        if (before.qty === undefined) delete slice.qty;
        else slice.qty = before.qty;
        deps.jobs.write(job);
      }
      throw err;
    }
    job.topUpPending = false;
    if (step.retry) {
      step.retry = null;
      deps.jobs.write(job);
    }
  };

  const noProfitLeft = async (step: Step, leg: RealizeJobLeg, follow: StepPerp, mid: number): Promise<boolean> => {
    const held = ((await crossEx().listCrossexPositions()).body ?? []).find((position) => position.symbol === leg.symbol);
    const entry = positiveOf(held?.entryPrice);
    const mark = positiveOf(held?.markPrice) || mid;
    if (!(entry > 0) || !(mark > 0)) return false;
    const perCoin = leg.side === 'SHORT' ? entry - mark : mark - entry;
    if (perCoin > (mark * feeBpOf(step)) / 10_000) return false;
    const stop = { symbol: leg.symbol, exchange: leg.exchange, base: leg.base, side: leg.side, entry, mark, closedQty: leg.filledQty, plannedQty: leg.qty, at: deps.now() };
    job.profitStops = [...(job.profitStops ?? []), stop];
    trimLegConverts(step, leg);
    finishSlices(step, leg, follow);
    return true;
  };

  const trimLegConverts = (step: Step, leg: RealizeJobLeg): void => {
    const from = job.steps.indexOf(step) + 1;
    const end = job.steps.findIndex((later, at) => at >= from && !later.name.startsWith('Convert'));
    const own = job.steps.slice(from, end < 0 ? job.steps.length : end).filter((convert) => !convert.retry && !isSent(convert) && convert.status !== 'done');
    if (own.length === 0) return;
    const share = leg.qty > 0 ? Math.min(1, leg.filledQty / leg.qty) : 0;
    const planned = own.filter((convert) => convert.name !== 'Convert to USDC').reduce((total, convert) => total + (convert.planned ?? 0), 0);
    const amount = floorCents(planned * share);
    const at = job.steps.indexOf(own[0]);
    job.steps = job.steps.filter((convert) => !own.includes(convert));
    if (amount >= HYPERLIQUID_MIN_USDC) job.steps.splice(at, 0, ...asRealize(convertSteps(own[0].from, own[0].to, amount)));
  };

  const finishSlices = (step: Step, leg: RealizeJobLeg, follow: StepPerp): void => {
    const skew = Math.max(0, addQty(wholeLegOf(job, leg.symbol)?.before ?? leg.qty, -followPlannedOf(job, step, leg)));
    const rest = Math.max(0, addQty(addQty(leg.filledQty, -(step.qty ?? 0)), -skew));
    const gap = rest > 0 ? restGapOf(job, leg, follow.symbol, rest) : null;
    if (gap) job.openGaps = [...(job.openGaps ?? []), gap];
    finish(step, step.qty ?? 0, step.from);
  };

  const runSlices = async (step: Step, perp: StepPerp, leg: RealizeJobLeg): Promise<void> => {
    const follow = step.follow;
    if (!follow) return halt(`unknown step ${step.name}`);
    try {
      const engine = engineOf(deps);
      const child = step.lead ? engine.store.getPair(step.lead.text) : null;
      if (step.lead && !child) {
        step.lead = null;
        step.hedge = null;
        deps.jobs.write(job);
      }
      if (child) {
        creditSliceChild(job, engine.store, child);
        deps.jobs.write(job);
        if (isLive(child)) {
          if (isWalledStop(engine.store, child)) return haltWalled(engine.store, child);
          if ((twap || longWait) && job.pauseRequested) {
            commands.stop(engine.store, child.id);
            engine.engineWake();
          }
          return deps.sleep(POLL_MS);
        }
        if (child.mode === 'HALTED') return await onHalted(step, leg, child);
        if (step.cut) step.cut.taker = engine.store.listOrders(child.id).some((row) => row.leg === 'A' && row.kind === 'taker' && Number(row.cumQty) > 0);
        await costChild(step, leg, child);
        if (job.kind === 'delever') job.imUsedNow = (await readImUsed(deps)) ?? job.imUsedNow;
        if (twap && job.delever && !(await borosAfterSlice())) return;
        deps.jobs.write(job);
        if (refusedAsTooSmall(engine.store, child)) return finishSlices(step, leg, follow);
      }
      if (job.status !== 'running') return;
      const queued = deps.takeFix?.();
      if (queued) return await applyFix(deps, job, queued.action).then(queued.done, queued.fail);
      if (job.pauseRequested) return pauseNow();
      const rule = await sliceRule(deps, perp.symbol);
      const followRule = follow.symbol === perp.symbol ? rule : await sliceRule(deps, follow.symbol);
      const lot = Number(followRule.lot) > Number(rule.lot) ? followRule.lot : rule.lot;
      const leadLots = Math.min(lotsOf(addQty(leg.qty, -leg.filledQty), rule.lot), lotsOf(addQty(leg.positionQty, -leg.filledQty), rule.lot));
      const leadLive = leadLots > 0 && wholeLegOf(job, leg.symbol) ? await wholeLotsOf(leg, rule.lot, leadLots) : Math.max(0, leadLots);
      const leadLeft = Number(qtyText(leadLive, rule.lot));
      const followWhole = job.kind === 'delever' ? wholeLegOf(job, follow.symbol) : null;
      const followPlanned = addQty(followPlannedOf(job, step, leg), -(step.qty ?? 0));
      const followLeft = followWhole ? Math.min(followPlanned, await liveQtyOf(follow.symbol, followWhole.side)) : followPlanned;
      const pairLeft = job.kind === 'delever' ? Math.min(leadLeft, followLeft) : leadLeft;
      if (lotsDownOf(pairLeft, lot) > 0) {
        if (twapWaits(step)) return deps.sleep(POLL_MS);
        const mid = await midOf(deps, perp.symbol);
        if (mid === null) return deps.sleep(POLL_MS);
        if (job.kind === 'realize' && (await noProfitLeft(step, leg, follow, mid))) return;
        if (job.kind === 'realize' && !(await mayStartSlice(step, leg))) return;
        const capOf = (size: string | undefined): number => (positiveOf(size) > 0 ? positiveOf(size) : Infinity);
        const venueCapOf = (symbol: string): number => {
          const capUsd = job.slice?.capsUsd?.[symbol] ?? 0;
          return capUsd > 0 ? capUsd / mid : Infinity;
        };
        const capQty = Math.min(
          capOf(rule.limits.maxMarketSize),
          capOf(followRule.limits.maxMarketSize),
          job.exec === 'maker' ? capOf(rule.limits.maxLimitSize) : Infinity,
          venueCapOf(perp.symbol),
          venueCapOf(follow.symbol),
        );
        return await startSlice(step, perp, follow, leg, pairLeft, lot, rule, mid, capQty);
      }
      const excessLead = followWhole !== null && wholeLegOf(job, leg.symbol) !== null && leadLive > 0;
      const excessFollow = followWhole !== null && lotsDownOf(followLeft, followRule.lot) > 0;
      if (excessLead || excessFollow) {
        const on = excessLead ? perp : follow;
        const onRule = excessLead ? rule : followRule;
        const lots = lotsDownOf(excessLead ? leadLeft : followLeft, onRule.lot);
        const mid = (await midOf(deps, on.symbol)) ?? 0;
        const id = nextChildId(engine.store, job.id, job.slice?.index ?? 1);
        const req = oneLegChild(id, on, qtyText(lots, onRule.lot));
        try {
          return await sendChild(step, perp, req, mid, null);
        } catch (err) {
          if (!isBelowMinimum(err)) throw err;
        }
      }
      finishSlices(step, leg, follow);
    } catch (err) {
      const c = classifyGateError(err);
      if (c.retryable) return deps.sleep(POLL_MS);
      if (c.category === 'auth') return halt(REOPEN_HALT.tradePermission);
      if (c.category === 'insufficient-margin' && job.kind === 'realize') return topUp(step, leg);
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

  if (job.status === 'running' && (job.paused || job.haltKind || job.notHedgedQty > 0)) {
    job.paused = false;
    job.haltKind = null;
    job.notHedgedQty = 0;
    job.follow = null;
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
      const longRunning = step.name === SLICE_STEP || spec.kind === 'boros';
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
        if (!step.perp || !leg || step.name !== SLICE_STEP) halt(`unknown step ${step.name}`);
        else await runSlices(step, step.perp, leg);
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
