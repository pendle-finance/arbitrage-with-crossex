import { useId, type ReactNode } from 'react';
import type { CrossexAccount, EvenPlan, GateAccount, PlannedStep, Pool, PositionsResponse, RebalanceBucket } from '../api/types';
import type { RebalanceJob, RouteName, RoutePlan, TransferCoin, TransferView, WalletAfter } from '../api/types';
import { Chip } from '../components/Chip';
import { HoverCard } from '../components/HoverCard';
import { RadioRow } from '../components/RadioRow';
import { microLabelClass, Th } from '../components/Th';
import { borrowedBucket, MIN_BORROW } from '../lib/borrow';
import { fmtAbout, fmtAge, fmtUsd, num } from '../lib/fmt';
import { fmtLinePrice, fmtMove, lineFor, liquidationLines, nearestLiquidation, type LiquidationLine } from '../lib/liquidation';
import { floorCents } from '../lib/ticks';
import { roundSeconds } from './RebalanceBits';
import { HOVER, MOVE_TEXT, poolKey, roundCount, WALLET_LABEL } from './rebalanceCopy';
import { findPath } from './TransferBits';

const BORROW_INITIAL_MARGIN = 0.2;
const HYPERLIQUID_INTEREST_FREE_USDC = 10_000;
export const DUST = 1;

export const ROUTE_LABEL: Record<RouteName, string> = { mix: 'Spot loop, then Convert', loop: 'Spot loop', convert: 'Convert' };

const WALLET_HOVER: Readonly<Record<string, string>> = {
  'USDT/CROSSEX': HOVER.walletUsdt,
  'USDC/HYPERLIQUID': HOVER.walletUsdc,
  'USDC/LIGHTER': HOVER.walletLighter,
  'USDC/GATE': HOVER.walletGate,
};

export interface Fact {
  key: string;
  label: ReactNode;
  value: ReactNode;
  warn?: boolean;
}

export const keyOf = (wallet: { coin: string; venue: string }) => `${wallet.coin}/${wallet.venue}`;
const equityOf = (wallets: WalletAfter[], key: string) => wallets.find((w) => keyOf(w) === key)?.equity ?? 0;

type Move = Pick<PlannedStep, 'from' | 'to'>;

export const planSteps = (plan: EvenPlan): PlannedStep[] => [
  ...(plan.routes.mix?.steps ?? []),
  ...plan.routes.loop.steps,
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

export function receivingBorrow(buckets: RebalanceBucket[], steps: readonly Move[]): number | null {
  const keys = new Set(steps.map((step) => poolKey(step.to)));
  const lent = buckets.filter((b) => keys.has(keyOf(b)) && floorCents(b.borrow) >= MIN_BORROW);
  return lent.length === 0 ? null : lent.reduce((total, b) => total + b.borrow, 0);
}

export const roundCountOf = (job: RebalanceJob) =>
  new Set(job.steps.flatMap((step) => (step.round === null ? [] : [step.round]))).size;

export function stepsNoun(route: RoutePlan): string {
  const count = route.steps.length;
  if (route.steps.every((step) => step.kind === 'round')) {
    return count === 1 ? 'the round' : `the ${num(count, 0)} rounds`;
  }
  return count === 1 ? 'the step' : `the ${num(count, 0)} steps`;
}

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
        </div>
      ))}
    </dl>
  );
}

export function borrowFacts(buckets: RebalanceBucket[]): Fact[] {
  const borrowed = borrowedBucket(buckets);
  const paid = buckets.reduce((sum, b) => sum + b.interestPaidUsd, 0);
  const paidFact: Fact = { key: 'paid', label: <Term label="Interest paid" text={HOVER.interestPaid} />, value: fmtUsd(paid) };
  if (!borrowed) return paid >= 0.01 ? [paidFact] : [];
  const isHyperliquid = borrowed.coin === 'USDC' && borrowed.venue === 'HYPERLIQUID';
  const interest =
    isHyperliquid && borrowed.borrow <= HYPERLIQUID_INTEREST_FREE_USDC
      ? `none under ${num(HYPERLIQUID_INTEREST_FREE_USDC, 0)} USDC`
      : `${fmtUsd(borrowed.interestPerDayUsd)} a day`;
  const interestText = isHyperliquid
    ? HOVER.interestUsdc
    : borrowed.venue === 'LIGHTER'
      ? HOVER.interestLighter
      : HOVER.interestUsdt;
  return [
    { key: 'lent', label: 'Lent by Gate', value: `${num(floorCents(borrowed.borrow))} ${borrowed.coin}` },
    { key: 'interest', label: <Term label="Interest" text={interestText} />, value: interest },
    paidFact,
  ];
}

function amountIn(plan: EvenPlan, amount: number): string {
  const senders = new Set(planSteps(plan).map((step) => step.from));
  if (senders.size === 0) return fmtUsd(amount);
  if (!senders.has('CROSSEX')) return `${num(amount)} USDC`;
  return senders.size === 1 ? `${num(amount)} USDT` : fmtUsd(amount);
}

function shortFact(plan: EvenPlan): Fact {
  const short = <Term label="Short of even" text={HOVER.shortOfEven} />;
  return { key: 'short', label: short, value: amountIn(plan, plan.shortOfEven), warn: true };
}

export const isCashLimitedEven = (plan: EvenPlan) => plan.balanced && plan.shortOfEven >= DUST;

export function positionShares(plan: EvenPlan): Map<string, string> {
  if (plan.noLegs) return new Map();
  return new Map(plan.split.map((share) => [keyOf(share), `${num(share.share * 100, 0)}% · ${fmtUsd(share.notionalUsd, 0)}`]));
}

export function cashFacts(plan: EvenPlan): Fact[] {
  if (plan.shortOfEven <= 0) return [];
  return [{ key: 'moves', label: 'Moves', value: amountIn(plan, plan.moves) }, shortFact(plan)];
}

export function balancedFacts(plan: EvenPlan, job: RebalanceJob | null): Fact[] {
  return [...(isCashLimitedEven(plan) ? [shortFact(plan)] : []), ...lastRunFacts(job)];
}

export function quoteFacts(quote: {
  route: RoutePlan;
  borrow: number | null;
  buckets: RebalanceBucket[];
  account: CrossexAccount | undefined;
  positions: PositionsResponse | undefined;
}): Fact[] {
  const { route, borrow, buckets, account, positions } = quote;
  const facts: Fact[] = [];
  if (borrow !== null) {
    facts.push(
      { key: 'frees', label: <Term label="Frees" text={HOVER.frees} />, value: `${fmtUsd(route.marginFreedUsd)} margin` },
      { key: 'saves', label: <Term label="Saves" text={HOVER.saves} />, value: `${fmtUsd(route.savesPerDayUsd)} / day` },
    );
  }
  const before = nearestLiquidation(account, positions);
  if (!before || !account || !positions) return facts;
  const shiftOf = (key: string) => equityOf(route.after, key) - equityOf(buckets, key);
  const moved = liquidationLines(account, positions, {
    'USDT/CROSSEX': shiftOf('USDT/CROSSEX'),
    'USDC/HYPERLIQUID': shiftOf('USDC/HYPERLIQUID'),
    'USDC/LIGHTER': shiftOf('USDC/LIGHTER'),
  });
  const after = moved ? lineFor(moved, before.base) : null;
  const at = (line: LiquidationLine) => `${fmtLinePrice(line.price)} (${fmtMove(line.move)})`;
  const afterText = after === 'far' ? 'none' : after ? at(after) : 'unknown';
  const value = `${before.base} ${at(before)} → ${afterText}`;
  facts.push({ key: 'liquidation', label: <Term label="Liquidation" text={HOVER.liquidation} />, value });
  return facts;
}

function lastRunFacts(job: RebalanceJob | null): Fact[] {
  if (job?.status !== 'done') return [];
  const rounds = roundCount(roundCountOf(job));
  const text = job.route === 'convert' ? 'Convert' : job.route === 'mix' ? `${rounds}, then Convert` : `${rounds} of spot loop`;
  const took = (job.steps.at(-1)?.doneAt ?? job.updatedAt) - job.createdAt;
  return [
    { key: 'last', label: 'Last run', value: text },
    { key: 'took', label: 'Took', value: fmtAge(took) },
    ...(job.costUsd === null ? [] : [{ key: 'cost', label: 'Cost', value: fmtUsd(job.costUsd) }]),
  ];
}

function whyText(route: RouteName, routePlan: RoutePlan, cap: number, onePerWallet: boolean): string {
  if (route === 'loop' && onePerWallet) return routePlan.rounds === 1 ? HOVER.whyLoopOne : HOVER.whyOnePerWallet;
  if (route === 'loop') return HOVER.whyLoopMore(routePlan.rounds);
  if (routePlan.rounds >= cap) return HOVER.whyMixAtCap(cap);
  if (routePlan.oneMoreRoundCostUsd === null) return HOVER.whyMixCheapest(routePlan.rounds);
  return HOVER.whyMixUnderCap(routePlan.rounds, fmtUsd(routePlan.costUsd), fmtUsd(routePlan.oneMoreRoundCostUsd));
}

interface RouteRowProps {
  route: RouteName;
  plan: EvenPlan;
  borrow: number | null;
}

const aboutText = (seconds: number): string => {
  const about = fmtAbout(seconds);
  return `${about.charAt(0).toUpperCase()}${about.slice(1)}`;
};

function RoundsTerm({ route, routePlan, plan, borrow }: RouteRowProps & { routePlan: RoutePlan }) {
  const n = routePlan.rounds;
  const rounds = routePlan.steps.filter((step) => step.kind === 'round');
  const moves = movesOf(rounds);
  const onePerWallet = rounds.length === moves.length;
  const lines: { term: string; text: string }[] = moves.map(({ from, to }) => ({
    term: moves.length === 1 ? HOVER.roundLabel : MOVE_TEXT.roundTerm(from, to),
    text: MOVE_TEXT.round(from, to, aboutText(roundSeconds(from, to))),
  }));
  if (n > 1 && !onePerWallet) {
    const locks = borrow === null ? '' : ` ${HOVER.whyMoreThanOneBorrow(fmtUsd(borrow * BORROW_INITIAL_MARGIN))}`;
    lines.push({ term: HOVER.whyMoreThanOneLabel, text: `${HOVER.whyMoreThanOne}${locks}` });
  }
  lines.push({ term: HOVER.whyLabel(n), text: whyText(route, routePlan, plan.roundCap, onePerWallet) });
  return (
    <HoverCard icon={false} widthPx={380} label={roundCount(n)}>
      <dl className="flex flex-col gap-2 text-xs leading-snug">
        {lines.map((line) => (
          <div key={line.term} className="flex flex-col gap-0.5">
            <dt className={microLabelClass}>{line.term}</dt>
            <dd>{line.text}</dd>
          </div>
        ))}
      </dl>
    </HoverCard>
  );
}

export function RouteRow({ route, plan, borrow, checked, onPick }: RouteRowProps & { checked: boolean; onPick: () => void }) {
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
  const time = `${route === 'mix' ? ', then Convert' : ''} · ${fmtAbout(routePlan.seconds)}`;
  const rounds = <RoundsTerm route={route} routePlan={routePlan} plan={plan} borrow={borrow} />;
  return (
    <RadioRow name="rebalance-route" labelledBy={id} checked={checked} disabled={blocked} onPick={onPick}>
      <span id={id} className="w-44 shrink-0">
        <Term label={<span className="font-semibold text-ink-100">{ROUTE_LABEL[route]}</span>} text={nameText} />
      </span>
      <span className="flex h-4 w-28 shrink-0 items-center">
        {plan.recommended === route && <Term label={<Chip tone="green" sm>Recommended</Chip>} text={HOVER.recommended} />}
      </span>
      <span className={`flex-1 ${blocked ? 'text-amber-300' : 'text-ink-400'}`}>
        {blocked && routePlan.reason}
        {!blocked && route === 'convert' && 'instant'}
        {!blocked && route !== 'convert' && <>{rounds}{time}</>}
      </span>
      {!blocked && <span className="num text-ink-100">{fmtUsd(routePlan.costUsd)}</span>}
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
            <Term label="Gate spot" text={HOVER.gateSpot} /> has {amount(`${num(spot.available)} ${spot.coin}`)}. Move it in
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
