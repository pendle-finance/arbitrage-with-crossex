import { Fragment, useId, type ReactNode } from 'react';
import type { CrossexAccount, EvenPlan, GateAccount, GoalKind, PlannedStep, Pool, PositionsResponse, RebalanceBucket, RebalanceJob } from '../api/types';
import type { RebalanceView, RouteName, RoutePlan, TransferCoin, TransferView, WalletAfter } from '../api/types';
import { Chip } from '../components/Chip';
import { HoverCard } from '../components/HoverCard';
import { RadioRow } from '../components/RadioRow';
import { microLabelClass, Th } from '../components/Th';
import { borrowingBuckets, borrowTotalUsd, MIN_BORROW } from '../lib/borrow';
import { fmtAbout, fmtUsd, num, WALLET_SHORT } from '../lib/fmt';
import { liquidationLines, type LiquidationLine } from '../lib/liquidation';
import { floorCents } from '../lib/ticks';
import { ALWAYS_SHOWN, ROUTE_ORDER, WALLET_TONE, type BarRow } from './RebalanceBits';
import {
  FACT_BORROWING,
  FACT_INTEREST_NOW,
  FACT_INTEREST_PAID,
  GATE_SPOT,
  HOVER,
  MODAL_FEE,
  MOVE_TEXT,
  PAYS_BACK,
  poolKey,
  RATE_PER_YEAR,
  INTEREST_PER_HOUR,
  RATE_UNKNOWN,
  VERDICT_NO_BORROW,
  VERDICT_NO_INTEREST,
  VERDICT_NOT_WORTH_IT,
  VERDICT_RATE_UNKNOWN,
  VERDICT_REPAY_NO_LEGS_SUB,
  VERDICT_REPAY_WORTH_IT,
  VERDICT_WORTH_IT,
  WALLET_LABEL,
} from './rebalanceCopy';
import { findPath } from './TransferBits';

const HYPERLIQUID_INTEREST_FREE_USDC = 10_000;
export const DUST = 1;
const TRANSIT_WALLET = 'USDC/GATE';

export const ROUTE_LABEL: Record<RouteName, string> = { mix: 'Spot loop, then Convert', loop: 'Spot loop', convert: 'Convert' };

const WALLET_HOVER: Readonly<Record<string, string>> = {
  'USDT/CROSSEX': HOVER.walletUsdt,
  'USDC/HYPERLIQUID': HOVER.walletUsdc,
  'USDC/LIGHTER': HOVER.walletLighter,
  'USDC/GATE': HOVER.walletGate,
};

export interface FactRow {
  name: string;
  value: string;
}

export interface Fact {
  key: string;
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode[];
  rows?: FactRow[];
  warn?: boolean;
}

export const keyOf = (wallet: { coin: string; venue: string }) => `${wallet.coin}/${wallet.venue}`;

type Move = Pick<PlannedStep, 'from' | 'to'>;

export const planSteps = (plan: EvenPlan): PlannedStep[] => [
  ...(plan.routes.mix?.steps ?? []),
  ...(plan.routes.loop?.steps ?? []),
  ...plan.routes.convert.steps,
];

export function movesOf(steps: readonly Move[]): Move[] {
  const moves: Move[] = [];
  for (const { from, to } of steps) {
    if (!moves.some((move) => move.from === from && move.to === to)) moves.push({ from, to });
  }
  return moves;
}

export const movesKey = (steps: readonly Move[]): string => movesOf(steps).map((move) => `${move.from}>${move.to}`).join(',');

function receivingLent(buckets: RebalanceBucket[], steps: readonly Move[]): RebalanceBucket[] {
  const keys = new Set(steps.map((step) => poolKey(step.to)));
  return buckets.filter((b) => keys.has(keyOf(b)) && floorCents(b.borrow) >= MIN_BORROW);
}

export function receivingBorrow(buckets: RebalanceBucket[], steps: readonly Move[]): number | null {
  const lent = receivingLent(buckets, steps);
  return lent.length === 0 ? null : lent.reduce((total, b) => total + b.borrow, 0);
}

export function receivingHeld(buckets: RebalanceBucket[], steps: readonly Move[]): number | null {
  const lent = receivingLent(buckets, steps);
  return lent.length === 0 ? null : lent.reduce((total, b) => total + b.imHeldUsd, 0);
}

export const roundCountOf = (job: RebalanceJob) =>
  new Set(job.steps.flatMap((step) => (step.round === null ? [] : [step.round]))).size;

export const roundOf = (job: RebalanceJob): number | null => job.steps[job.stepIndex]?.round ?? null;

export function Term({
  label,
  text,
  underline,
  wrapsControl,
}: {
  label: ReactNode;
  text: string;
  underline?: boolean;
  wrapsControl?: boolean;
}) {
  return (
    <HoverCard icon={false} underline={underline} wrapsControl={wrapsControl} widthPx={320} label={label}>
      <p className="text-xs leading-snug">{text}</p>
    </HoverCard>
  );
}

function InterestInfo({ buckets }: { buckets: RebalanceBucket[] }) {
  const info = HOVER.interestNow;
  const rateOf = (key: string) => {
    const bucket = buckets.find((b) => keyOf(b) === key);
    return bucket ? rateText(bucket) : RATE_UNKNOWN;
  };
  const cell = 'whitespace-nowrap px-2 py-1';
  return (
    <HoverCard icon={false} widthPx={520} label={FACT_INTEREST_NOW}>
      <div className="flex flex-col gap-2 text-xs leading-snug">
        <p>{info.lead}</p>
        <table className="w-full border border-ink-700">
          <thead>
            <tr>
              <Th className="text-left">{info.head.wallet}</Th>
              <Th className="text-left">{info.head.interest}</Th>
              <Th className="text-right">{info.head.rate}</Th>
            </tr>
          </thead>
          <tbody>
            {info.wallets.map((row) => (
              <tr key={row.key} className="border-t border-ink-700">
                <td className={cell}>{WALLET_LABEL[row.key]}</td>
                <td className={cell}>{row.interest}</td>
                <td className={`${cell} num text-right`}>{rateOf(row.key)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </HoverCard>
  );
}

export function WalletTerm({ wallet }: { wallet: string }) {
  return <Term label={<span className="text-ink-100">{WALLET_LABEL[wallet]}</span>} text={WALLET_HOVER[wallet]} />;
}

export function Facts({ items, className = 'flex flex-wrap gap-x-7 gap-y-2' }: { items: Fact[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <dl className={className}>
      {items.map((fact) => (
        <div key={fact.key} className="flex flex-col gap-0.5">
          <dt className={microLabelClass}>{fact.label}</dt>
          <dd className={`num text-sm ${fact.warn ? 'text-amber-300' : 'text-ink-100'}`}>{fact.value}</dd>
          {(fact.sub ?? []).map((line, index) => (
            <dd key={`${fact.key}-${index}`} className="num text-xs text-ink-400">
              {line}
            </dd>
          ))}
          {fact.rows && fact.rows.length > 0 && (
            <dd data-fact-rows={fact.key} className="grid w-fit grid-cols-[auto_auto] gap-x-3 text-xs text-ink-400">
              {fact.rows.map((row) => (
                <Fragment key={row.name}>
                  <span>{row.name}</span>
                  <span className="num whitespace-nowrap text-right">{row.value}</span>
                </Fragment>
              ))}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

const freePartOf = (b: RebalanceBucket) => (b.coin === 'USDC' && b.venue === 'HYPERLIQUID' ? HYPERLIQUID_INTEREST_FREE_USDC : 0);

export const chargedBorrow = (b: RebalanceBucket, borrow: number) => Math.max(0, borrow - freePartOf(b));

export const isRateUnknown = (b: RebalanceBucket) => chargedBorrow(b, b.borrow) > 0 && b.interestPerDayUsd === 0;

function rateText(b: RebalanceBucket): string {
  if (isRateUnknown(b) || b.ratePerYear === null || b.ratePerYear <= 0) return RATE_UNKNOWN;
  return RATE_PER_YEAR(num(b.ratePerYear * 100, 2));
}

function perHourText(usd: number): string {
  if (usd <= 0) return fmtUsd(0);
  if (usd < 0.0001) return `under ${fmtUsd(0.0001, 4)}`;
  return fmtUsd(usd, usd < 1 ? 4 : 2);
}

const walletPerHour = (b: RebalanceBucket) =>
  isRateUnknown(b) ? RATE_UNKNOWN : INTEREST_PER_HOUR(perHourText(b.interestPerDayUsd / 24));

const walletRows = (wallets: RebalanceBucket[], valueOf: (b: RebalanceBucket) => string): FactRow[] =>
  wallets.map((b) => ({ name: WALLET_SHORT[keyOf(b)], value: valueOf(b) }));

export function sharedCoin(wallets: readonly { coin: string }[]): string | null {
  const coins = new Set(wallets.map((w) => w.coin));
  return coins.size === 1 ? [...coins][0] : null;
}

export const fmtCoinOrUsd = (value: number, coin: string | null): string => (coin ? `${num(value)} ${coin}` : fmtUsd(value));

export interface Repay {
  wallets: RebalanceBucket[];
  amount: number;
  stopsPerDayUsd: number | null;
  charged: { bucket: RebalanceBucket; before: number; after: number }[];
}

export function repayOf(buckets: RebalanceBucket[], route: RoutePlan): Repay {
  const parts = borrowingBuckets(buckets).flatMap((bucket) => {
    const after = route.after.find((w) => keyOf(w) === keyOf(bucket));
    // Gate's borrow follows cash, not equity: a wallet in profit can owe more
    // than minus its equity. So, like the server, count what the move sends in
    // against the borrow, not the equity after it.
    const received = after ? Math.max(0, after.equity - bucket.equity) : 0;
    const left = Math.max(0, bucket.borrow - received);
    const amount = Math.max(0, bucket.borrow - left);
    return floorCents(amount) > 0 ? [{ bucket, amount, left }] : [];
  });
  const charged = parts.map(({ bucket, left }) => ({ bucket, before: chargedBorrow(bucket, bucket.borrow), after: chargedBorrow(bucket, left) }));
  const stops = charged.reduce(
    (total, { bucket, before, after }) => (before === 0 ? total : total + (bucket.interestPerDayUsd * (before - after)) / before),
    0,
  );
  return {
    wallets: parts.map((part) => part.bucket),
    amount: parts.reduce((total, part) => total + part.amount, 0),
    stopsPerDayUsd: parts.some((part) => isRateUnknown(part.bucket)) ? null : stops,
    charged,
  };
}

function borrowHover(borrowing: RebalanceBucket[]): string {
  return borrowing.length === 0 ? HOVER.rebalanceTitle.borrow : HOVER.borrowing;
}

export function borrowingFact(buckets: RebalanceBucket[]): Fact & { value: string } {
  const borrowing = borrowingBuckets(buckets);
  const total = borrowTotalUsd(buckets);
  const coin = sharedCoin(borrowing);
  const borrowAmount = (value: number) => (coin ? num(value) : fmtUsd(value));
  return {
    key: 'borrowing',
    label: FACT_BORROWING,
    value: total > 0 ? fmtCoinOrUsd(total, coin) : 'none',
    sub: borrowing.length === 1 ? [WALLET_LABEL[keyOf(borrowing[0])]] : [],
    rows: borrowing.length > 1 ? walletRows(borrowing, (b) => borrowAmount(floorCents(b.borrow))) : [],
    warn: total > 0,
  };
}

type StaleLeg = { base: string; venue: string; sinceMs: number };

export function liquidationNow(
  acc: CrossexAccount | undefined,
  pos: PositionsResponse | undefined,
): LiquidationLine | StaleLeg | null | 'unknown' {
  const view = acc && pos ? liquidationLines(acc, pos, {}, pos.marginTiers) : null;
  if (!view) return 'unknown';
  for (const stale of view.unknown) {
    if (stale.sinceMs !== null) return { base: stale.base, venue: stale.venue, sinceMs: stale.sinceMs };
  }
  return view.lines[0] ?? null;
}

/** The per-wallet lines of a card figure, shown on hover. With two or three
 * wallets, lines under the figure crowd the card. */
function RowsHover({ factKey, value, rows, warn }: { factKey: string; value: string; rows: FactRow[]; warn?: boolean }) {
  // The trigger's own grey would hide the figure's colour, so the figure keeps it.
  const label = <span className={warn ? 'text-amber-300' : 'text-ink-100'}>{value}</span>;
  return (
    <HoverCard icon={false} widthPx={320} label={label}>
      <div data-fact-rows={factKey} className="grid w-fit grid-cols-[auto_auto] gap-x-4 gap-y-1 text-xs">
        {rows.map((row) => (
          <Fragment key={row.name}>
            <span>{row.name}</span>
            <span className="num whitespace-nowrap text-right">{row.value}</span>
          </Fragment>
        ))}
      </div>
    </HoverCard>
  );
}

const rowsOnHover = (fact: Fact & { value: string }): Fact =>
  fact.rows && fact.rows.length > 0
    ? { ...fact, value: <RowsHover factKey={fact.key} value={fact.value} rows={fact.rows} warn={fact.warn} />, rows: [] }
    : fact;

export function borrowFacts(buckets: RebalanceBucket[]): Fact[] {
  const borrowing = borrowingBuckets(buckets);
  const perHour = buckets.reduce((sum, b) => sum + b.interestPerDayUsd, 0) / 24;
  const paid = buckets.reduce((sum, b) => sum + b.interestPaidUsd, 0);
  const paidWallets = buckets.filter((b) => floorCents(b.interestPaidUsd) > 0).sort((a, b) => b.interestPaidUsd - a.interestPaidUsd);
  const borrowed = borrowingFact(buckets);
  return [
    rowsOnHover({ ...borrowed, label: <Term label={FACT_BORROWING} text={borrowHover(borrowing)} /> }),
    rowsOnHover({
      key: 'interest',
      label: <InterestInfo buckets={buckets} />,
      value: INTEREST_PER_HOUR(perHourText(perHour)),
      rows: walletRows(borrowing, walletPerHour),
      warn: perHour > 0,
    }),
    rowsOnHover({
      key: 'paid',
      label: FACT_INTEREST_PAID,
      value: fmtUsd(paid),
      rows: walletRows(paidWallets, (b) => fmtUsd(b.interestPaidUsd)),
    }),
  ];
}

/** A Rebalance is not worth it yet when its fee is more than this many days
 * of the borrow interest it stops. The owner set 30 days on 2026-09-17. */
export const WORTH_IT_DAYS = 30;
export const MONTH_DAYS = 30;

const cents = (usd: number): number => Math.round(usd * 100);

export const hasUnknownRate = (buckets: RebalanceBucket[]): boolean => borrowingBuckets(buckets).some(isRateUnknown);

/** The interest a day the route stops, from the wallets it repays. The
 * server's savesPerDayUsd is rounded to cents, which moves 30 days of it by
 * up to $0.15 and flips the verdict on a small borrow. */
export const stopsPerDayOf = (route: RoutePlan, buckets: RebalanceBucket[]): number => repayOf(buckets, route).stopsPerDayUsd ?? 0;

/** The fee as days of stopped interest, before rounding up. Null when the
 * route stops no interest. */
function paybackDays(route: RoutePlan, buckets: RebalanceBucket[]): number | null {
  const stops = stopsPerDayOf(route, buckets);
  return stops > 0 ? Number((route.costUsd / stops).toFixed(6)) : null;
}

/** Worth it when the fee is at most 30 whole days of the interest it stops,
 * rounded up, the same figure the line shows. A free route is always worth it. */
export function isWorthIt(route: RoutePlan, buckets: RebalanceBucket[]): boolean {
  if (cents(route.costUsd) <= 0) return true;
  const days = paybackDays(route, buckets);
  return days !== null && Math.ceil(days) <= WORTH_IT_DAYS;
}

/** A borrow whose interest is known, and a route whose fee is more than 30
 * days of the interest it stops. */
export const isNotWorthIt = (route: RoutePlan, buckets: RebalanceBucket[]): boolean =>
  borrowingBuckets(buckets).length > 0 && !hasUnknownRate(buckets) && !isWorthIt(route, buckets);

const daysText = (days: number): string => {
  if (days < 1) return 'less than a day';
  const whole = Math.ceil(days);
  return whole === 1 ? '1 day' : `${num(whole, 0)} days`;
};

/** Severity of a verdict, which picks its alert ground and icon.
 * `info` = nothing to do · `warn` = paying interest, but the fee outruns it
 * · `act` = the interest outruns the fee, so rebalance now. */
export type VerdictTone = 'info' | 'warn' | 'act';

/** Borrowing, but every borrow sits inside its wallet's interest-free
 * allowance, so nothing is being charged. `isRateUnknown` cannot catch this:
 * it requires `chargedBorrow > 0`, which is exactly what a free borrow is not. */
export const isFreeBorrow = (buckets: RebalanceBucket[]): boolean => {
  const borrowing = borrowingBuckets(buckets);
  return borrowing.length > 0 && borrowing.every((b) => chargedBorrow(b, b.borrow) <= 0);
};

/** A verdict: its sentence, its severity, and an optional second line that
 * carries the arithmetic behind it. */
export interface Verdict {
  text: string;
  tone: VerdictTone;
  /** The supporting figure, e.g. "The fee equals 22 days of the interest it saves." */
  sub?: string;
}

/** Whether the fee is worth the interest the route stops. Null when the app
 * cannot tell (a borrow rate is unknown) or there is nothing to weigh (no fee). */
/**
 * The verdict on a borrow. What decides it is whether POSITIONS exist, not
 * which goal is on screen (his catch 2026-09-19): with no legs the borrow is
 * simply holding cash you could withdraw, so no fee is weighed against it —
 * and that is as true of a custom move that clears the borrow as of the
 * preset. With legs the fee-versus-interest arithmetic applies to all three.
 */
export function worthLine(route: RoutePlan, buckets: RebalanceBucket[], goal: GoalKind = 'even', noLegs = false): Verdict | null {
  if (borrowingBuckets(buckets).length === 0) return { text: VERDICT_NO_BORROW, tone: 'info' };
  if (noLegs) return { text: VERDICT_REPAY_WORTH_IT, tone: 'act', sub: VERDICT_REPAY_NO_LEGS_SUB };
  // Before any fee-vs-interest test: with no interest there is nothing to weigh,
  // and weighing against zero is what made this print "not worth it" beside a
  // "$0.00 an hour" reading.
  if (isFreeBorrow(buckets)) return { text: VERDICT_NO_INTEREST, tone: 'info' };
  // A rate we could not read is an ERROR, not a quiet "nothing to do": the
  // dialog still prices a fee, so a silent card contradicted it.
  if (hasUnknownRate(buckets)) return { text: VERDICT_RATE_UNKNOWN, tone: 'warn' };
  if (isNotWorthIt(route, buckets)) return { text: VERDICT_NOT_WORTH_IT, tone: 'warn' };
  const days = paybackDays(route, buckets);
  if (cents(route.costUsd) <= 0 || days === null) return null;
  return { text: goal === 'repay' ? VERDICT_REPAY_WORTH_IT : VERDICT_WORTH_IT, tone: 'act', sub: PAYS_BACK(daysText(days)) };
}

export const isCashLimitedEven = (plan: EvenPlan) => plan.balanced && plan.shortOfEven >= DUST;

/**
 * The preset the card leads with, and the one its button opens: whichever is
 * actually WORTH DOING (his ruling 2026-09-19, superseding "even whenever
 * there are legs"). With a borrow the two presets clear the same interest, so
 * the cheaper move wins — leading with a $141 rebalance while a $13 debt
 * clear sat hidden in the dialog is what made the card and the dialog read as
 * contradicting each other. Ties and the no-borrow case keep `even`, which is
 * the feature's own name.
 */
export function defaultGoal(view: RebalanceView): 'even' | 'repay' {
  const { even, repay } = view.plans;
  if (even.balanced && !repay.balanced) return 'repay';
  if (repay.balanced) return 'even';
  // Both have something to do. The verdict decides: a preset that is not
  // worth its fee never leads over one that is.
  const verdictOf = (goal: 'even' | 'repay') => {
    const { name, route } = pickedRoute(view.plans[goal], null);
    return name === null ? null : worthLine(route, view.buckets, goal, view.plans[goal].noLegs);
  };
  return verdictOf('even')?.tone === 'act' || verdictOf('repay')?.tone !== 'act' ? 'even' : 'repay';
}

/** The equity each wallet is heading for. The even goal re-derives it from
 * the live equity (money in transit counts), the others aim at fixed figures. */
export function targetsOf(view: RebalanceView, plan: EvenPlan = view.plans.even): Map<string, number> {
  if (plan.goal.kind !== 'even') return new Map(plan.targets.map((target) => [keyOf(target), target.equity]));
  if (plan.noLegs) return new Map();
  const job = view.job;
  const transit = job && (job.status === 'running' || job.status === 'halted') ? (job.inTransit?.qty ?? 0) : 0;
  const equity = view.buckets.reduce((total, b) => total + b.equity, transit);
  return new Map(plan.split.map((share) => [keyOf(share), share.share * equity]));
}

export function barRowsOf(wallets: (WalletAfter | RebalanceBucket)[], keys: string[], target: Map<string, number>): BarRow[] {
  return keys.flatMap((key): BarRow[] => {
    const wallet = wallets.find((w) => keyOf(w) === key);
    if (!wallet) return [];
    return [
      {
        key,
        label: <WalletTerm wallet={key} />,
        name: WALLET_LABEL[key],
        cash: wallet.cash,
        upnl: 'upnl' in wallet ? wallet.upnl : wallet.equity - wallet.cash,
        target: target.size === 0 ? null : (target.get(key) ?? 0),
        tone: WALLET_TONE[key],
      },
    ];
  });
}

export function shownKeys(view: RebalanceView, steps: readonly Move[], plan: EvenPlan = view.plans.even): string[] {
  const touched = new Set(steps.flatMap((step) => [poolKey(step.from), poolKey(step.to)]));
  const target = targetsOf(view, plan);
  return Object.keys(WALLET_TONE).filter((key) => {
    const bucket = view.buckets.find((b) => keyOf(b) === key);
    if (!bucket) return false;
    if (key === TRANSIT_WALLET) return Math.abs(bucket.cash) >= DUST;
    if (ALWAYS_SHOWN.includes(key) || touched.has(key) || target.has(key)) return true;
    return Math.abs(bucket.cash) >= DUST || Math.abs(bucket.equity) >= DUST;
  });
}

export function pickedRoute(plan: EvenPlan, pick: RouteName | null): { name: RouteName | null; route: RoutePlan } {
  const isOpen = (name: RouteName | null): name is RouteName => name !== null && plan.routes[name]?.available === true;
  const name = [pick, plan.recommended, ...ROUTE_ORDER].find(isOpen) ?? null;
  return { name, route: (name === null ? null : plan.routes[name]) ?? plan.routes.convert };
}

export const routeTime = (route: RouteName, plan: RoutePlan): string =>
  route === 'convert' ? 'instant' : fmtAbout(plan.seconds);

export function RouteRow({ route, plan, checked, onPick }: { route: RouteName; plan: EvenPlan; checked: boolean; onPick: () => void }) {
  const id = useId();
  const routePlan = plan.routes[route];
  if (!routePlan) return null;
  const blocked = !routePlan.available;
  const moves = movesOf(planSteps(plan));
  const loop = [
    ...MOVE_TEXT.loop(moves),
    ...(moves.some((move) => move.to !== 'CROSSEX') ? [HOVER.noDirectTransfer] : []),
    HOVER.repeats,
  ].join(' ');
  const across = moves.some((move) => move.from !== 'CROSSEX' && move.to !== 'CROSSEX');
  const convert = across ? `${HOVER.convert} ${HOVER.convertAcross}` : HOVER.convert;
  const nameText = route === 'mix' ? HOVER.mix(plan.roundCap) : route === 'loop' ? loop : convert;
  const time = routeTime(route, routePlan);
  return (
    <RadioRow name="rebalance-route" labelledBy={id} checked={checked} disabled={blocked} onPick={onPick}>
      <span id={id} className="w-44 shrink-0">
        <Term label={<span className="font-semibold text-ink-100">{ROUTE_LABEL[route]}</span>} text={nameText} />
      </span>
      <span className="flex h-4 w-28 shrink-0 items-center">
        {plan.recommended === route && <Term label={<Chip tone="green" sm>Recommended</Chip>} text={HOVER.recommended} />}
      </span>
      <span className={`flex-1 ${blocked ? 'text-amber-300' : 'num text-ink-400'}`}>{blocked ? routePlan.reason : time}</span>
      {!blocked && <span className="num text-ink-100">{MODAL_FEE(fmtUsd(routePlan.costUsd))}</span>}
    </RadioRow>
  );
}

interface SpotLine {
  coin: TransferCoin;
  wallet: GateAccount;
  text: ReactNode;
}

type OnTransfer = (coin: TransferCoin, wallet: GateAccount) => void;

const LANDS_IN_SPOT: readonly string[] = ['To spot', 'From Hyperliquid', 'From Lighter'];

const VENUE_ACCOUNT: Record<Pool, GateAccount> = {
  CROSSEX: 'CROSSEX_GATE',
  HYPERLIQUID: 'CROSSEX_HYPERLIQUID',
  LIGHTER: 'CROSSEX_LIGHTER',
};

export function SpotLines({ transfer, job, onTransfer }: { transfer?: TransferView; job: RebalanceJob | null; onTransfer?: OnTransfer }) {
  const amount = (text: string) => <span className="num font-semibold text-ink-100">{text}</span>;
  const minInto = (target: GateAccount) => findPath(transfer?.paths ?? [], { from: 'SPOT', to: target })?.min ?? 0;
  const usdcWallet = (qty: number, target: GateAccount): GateAccount => (qty < minInto(target) ? 'CROSSEX_GATE' : target);
  const lines = (transfer?.spot ?? [])
    .filter((spot) => spot.available >= DUST)
    .map(
      (spot): SpotLine => ({
        coin: spot.coin,
        wallet: spot.coin === 'USDT' ? 'CROSSEX' : usdcWallet(spot.available, 'CROSSEX_HYPERLIQUID'),
        text: (
          <>
            <Term label={GATE_SPOT} text={HOVER.gateSpot} /> has {amount(`${num(spot.available)} ${spot.coin}`)}. Move it in
            to use it.
          </>
        ),
      }),
    );
  const leftInSpot =
    job?.inTransit?.at === 'SPOT' ||
    (job?.inTransit?.at === 'MOVING' && LANDS_IN_SPOT.includes(job.steps[job.stepIndex]?.name ?? ''));
  if (transfer?.spot === null && job?.status === 'abandoned' && job.inTransit && leftInSpot) {
    const wallet = usdcWallet(job.inTransit.qty, VENUE_ACCOUNT[job.steps[job.stepIndex]?.to ?? 'CROSSEX']);
    const text = <>Last run left {amount(`${num(job.inTransit.qty)} USDC`)} in Gate spot.</>;
    lines.push({ coin: 'USDC', wallet, text });
  }
  return (
    <>
      {lines.map((line) => (
        <div key={line.coin} className="flex flex-wrap items-center gap-3 rounded border border-dashed border-ink-700 px-3 py-2 text-xs text-ink-300">
          <p>{line.text}</p>
          <button type="button" className="btn-link" onClick={() => onTransfer?.(line.coin, line.wallet)}>
            Transfer ▸
          </button>
        </div>
      ))}
    </>
  );
}

export function RebalanceInfo() {
  const card = HOVER.rebalanceTitle;
  const cell = 'whitespace-nowrap px-2 py-1';
  return (
    <HoverCard widthPx={600} underline={false} label="Rebalance">
      <div className="flex flex-col gap-2 text-xs leading-snug">
        <p>{card.equity}</p>
        <table className="w-full border border-ink-700">
          <thead>
            <tr>
              <Th className="text-left">{card.walletHead.wallet}</Th>
              <Th className="text-left">{card.walletHead.legs}</Th>
              <Th className="text-left">{card.walletHead.interest}</Th>
            </tr>
          </thead>
          <tbody>
            {card.wallets.map((row) => (
              <tr key={row.wallet} className="border-t border-ink-700">
                <td className={cell}>{row.wallet}</td>
                <td className={cell}>{row.legs}</td>
                <td className={cell}>{row.interest}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>{card.borrow}</p>
        <p>{card.rounds}</p>
        <table className="w-full border border-ink-700">
          <thead>
            <tr>
              <Th className="text-left">{card.routeHead.route}</Th>
              <Th className="text-left">{card.routeHead.path}</Th>
              <Th className="text-right">{card.routeHead.time}</Th>
              <Th className="text-right">{card.routeHead.cost}</Th>
            </tr>
          </thead>
          <tbody>
            {card.routes.flatMap((group) =>
              group.paths.map((row, index) => (
                <tr key={`${group.route} ${row.path}`} className={index === 0 ? 'border-t border-ink-700' : undefined}>
                  {index === 0 && (
                    <td rowSpan={group.paths.length} className={`${cell} align-top`}>
                      {group.route}
                    </td>
                  )}
                  <td className={cell}>{row.path}</td>
                  <td className={`${cell} text-right`}>{row.time}</td>
                  <td className={`${cell} text-right`}>{row.cost}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
        <p>{card.recommended}</p>
      </div>
    </HoverCard>
  );
}
