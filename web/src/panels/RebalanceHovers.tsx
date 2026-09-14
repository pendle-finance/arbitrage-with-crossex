import { useId, type ReactNode } from 'react';
import type { CrossexAccount, EvenPlan, GateAccount, PositionsResponse, RebalanceBucket } from '../api/types';
import type { RebalanceJob, RouteName, RoutePlan, TransferCoin, TransferView, WalletAfter } from '../api/types';
import { Chip } from '../components/Chip';
import { HoverCard } from '../components/HoverCard';
import { microLabelClass, Th } from '../components/Th';
import { borrowedBucket } from '../lib/borrow';
import { fmtAbout, fmtAge, fmtUsd, num } from '../lib/fmt';
import { fmtLinePrice, fmtMove, lineFor, liquidationLines, nearestLiquidation, type LiquidationLine } from '../lib/liquidation';
import { floorCents } from '../lib/ticks';
import { HOVER, roundCount, WALLET_LABEL } from './rebalanceCopy';

const BORROW_INITIAL_MARGIN = 0.2;
const INTEREST_FREE_UNTIL = 10_000;
export const DUST = 1;

export const ROUTE_LABEL: Record<RouteName, string> = { mix: 'Spot loop, then Convert', loop: 'Spot loop', convert: 'Convert' };

const WALLET_HOVER: Readonly<Record<string, string>> = {
  'USDT/CROSSEX': HOVER.walletUsdt,
  'USDC/HYPERLIQUID': HOVER.walletUsdc,
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

export const roundCountOf = (job: RebalanceJob) =>
  new Set(job.steps.flatMap((step) => (step.round === null ? [] : [step.round]))).size;

export function toggleLabel(route: RoutePlan): string {
  const count = route.steps.length;
  if (route.steps.every((step) => step.kind === 'round')) {
    return count === 1 ? 'Show the round' : `Show the ${num(count, 0)} rounds`;
  }
  return count === 1 ? 'Show the step' : `Show the ${num(count, 0)} steps`;
}

export function Term({ label, text }: { label: ReactNode; text: string }) {
  return (
    <HoverCard icon={false} widthPx={320} label={label}>
      <p className="text-xs leading-snug">{text}</p>
    </HoverCard>
  );
}

export function WalletTerm({ wallet }: { wallet: string }) {
  return <Term label={<span className="text-ink-100">{WALLET_LABEL[wallet]}</span>} text={WALLET_HOVER[wallet]} />;
}

export function Facts({ items }: { items: Fact[] }) {
  if (items.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-7 gap-y-2">
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
  if (!borrowed) return [];
  const interest =
    borrowed.interestPerDayUsd > 0
      ? `${fmtUsd(borrowed.interestPerDayUsd)} / day`
      : `none under ${num(INTEREST_FREE_UNTIL, 0)} ${borrowed.coin}`;
  const paid = buckets.reduce((sum, b) => sum + b.interestPaidUsd, 0);
  return [
    { key: 'lent', label: 'Lent by Gate', value: `${num(floorCents(borrowed.borrow))} ${borrowed.coin}` },
    { key: 'interest', label: <Term label="Interest" text={HOVER.interest(borrowed.coin)} />, value: interest },
    { key: 'paid', label: <Term label="Interest paid" text={HOVER.interestPaid} />, value: fmtUsd(paid) },
  ];
}

export function cashFacts(plan: EvenPlan): Fact[] {
  if (plan.shortOfEven <= 0) return [];
  const coin = plan.direction === 'toUsdt' ? 'USDC' : 'USDT';
  const short = <Term label="Short of even" text={HOVER.shortOfEven} />;
  return [
    { key: 'moves', label: 'Moves', value: `${num(plan.moves)} ${coin}` },
    { key: 'short', label: short, value: `${num(plan.shortOfEven)} ${coin}`, warn: true },
  ];
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
  });
  const after = moved ? lineFor(moved, before.base) : null;
  const at = (line: LiquidationLine) => `${fmtLinePrice(line.price)} (${fmtMove(line.move)})`;
  const value = `${before.base} ${at(before)} → ${after && after !== 'far' ? at(after) : 'past 10x'}`;
  facts.push({ key: 'liquidation', label: <Term label="Liquidation" text={HOVER.liquidation} />, value });
  return facts;
}

export function lastRunFacts(job: RebalanceJob | null): Fact[] {
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

function whyText(route: RouteName, routePlan: RoutePlan, cap: number): string {
  if (route === 'loop') return routePlan.rounds === 1 ? HOVER.whyLoopOne : HOVER.whyLoopMore(routePlan.rounds);
  if (routePlan.rounds >= cap || routePlan.oneMoreRoundCostUsd === null) return HOVER.whyMixAtCap(cap);
  return HOVER.whyMixUnderCap(routePlan.rounds, fmtUsd(routePlan.costUsd), fmtUsd(routePlan.oneMoreRoundCostUsd));
}

interface RouteRowProps {
  route: RouteName;
  plan: EvenPlan;
  borrow: number | null;
}

function RoundsTerm({ route, routePlan, plan, borrow }: RouteRowProps & { routePlan: RoutePlan }) {
  const n = routePlan.rounds;
  const lines: { term: string; text: string }[] = [
    { term: HOVER.roundLabel, text: plan.direction === 'toUsdt' ? HOVER.roundToUsdt : HOVER.roundToUsdc },
  ];
  if (n > 1) {
    const locks = borrow === null ? '' : ` ${HOVER.whyMoreThanOneBorrow(fmtUsd(borrow * BORROW_INITIAL_MARGIN))}`;
    lines.push({ term: HOVER.whyMoreThanOneLabel, text: `${HOVER.whyMoreThanOne}${locks}` });
  }
  lines.push({ term: HOVER.whyLabel(n), text: whyText(route, routePlan, plan.roundCap) });
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
  const loop = plan.direction === 'toUsdt' ? HOVER.loopToUsdt : HOVER.loopToUsdc;
  const nameText = route === 'mix' ? HOVER.mix(plan.roundCap) : route === 'loop' ? loop : HOVER.convert;
  const time = `${route === 'mix' ? ', then Convert' : ''} · ${fmtAbout(routePlan.seconds)}`;
  const rounds = <RoundsTerm route={route} routePlan={routePlan} plan={plan} borrow={borrow} />;
  return (
    <label
      onClickCapture={blocked ? undefined : onPick}
      className={`flex min-h-[38px] items-center gap-3 rounded border px-3 py-1.5 text-xs ${checked ? 'border-info bg-ink-850' : 'border-ink-700'} ${blocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <input
        type="radio"
        name="rebalance-route"
        className={`chk ${blocked ? 'opacity-50' : ''}`}
        aria-labelledby={id}
        checked={checked}
        disabled={blocked}
        onChange={onPick}
      />
      <span id={id} className={`w-44 shrink-0 ${blocked ? 'opacity-50' : ''}`}>
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
    </label>
  );
}

interface SpotLine {
  coin: TransferCoin;
  wallet: GateAccount;
  text: ReactNode;
}

type OnTransfer = (coin: TransferCoin, wallet: GateAccount) => void;

export function SpotLines({ transfer, job, onTransfer }: { transfer?: TransferView; job: RebalanceJob | null; onTransfer?: OnTransfer }) {
  const amount = (text: string) => <span className="num font-semibold text-ink-100">{text}</span>;
  const lines = (transfer?.spot ?? [])
    .filter((spot) => spot.available >= DUST)
    .map(
      (spot): SpotLine => ({
        coin: spot.coin,
        wallet: spot.coin === 'USDT' ? 'CROSSEX' : 'CROSSEX_HYPERLIQUID',
        text: (
          <>
            <Term label="Gate spot" text={HOVER.gateSpot} /> has {amount(`${num(spot.available)} ${spot.coin}`)}. Move it in
            to use it.
          </>
        ),
      }),
    );
  if (transfer?.spot === null && job?.status === 'abandoned' && job.inTransit) {
    const wallet = job.direction === 'toUsdc' ? 'CROSSEX_HYPERLIQUID' : 'CROSSEX_GATE';
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
  const cell = 'px-2 py-1.5';
  return (
    <HoverCard widthPx={640} underline={false} label="Rebalance">
      <div className="flex flex-col gap-2 text-xs leading-snug">
        <p>{card.wallets}</p>
        <p>{card.equity}</p>
        <p>{card.rounds}</p>
        <table className="w-full border border-ink-700">
          <thead>
            <tr>
              <Th className="text-left">{card.head.route}</Th>
              <Th className="text-left">{card.head.how}</Th>
              <Th className="text-right">{card.head.time}</Th>
              <Th className="text-right">{card.head.cost}</Th>
            </tr>
          </thead>
          <tbody>
            {card.routes.map((row) => (
              <tr key={row.route} className="border-t border-ink-700">
                <td className={cell}>{row.route}</td>
                <td className={cell}>{row.how}</td>
                <td className={`${cell} text-right`}>{row.time}</td>
                <td className={`${cell} text-right`}>{row.cost}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>{card.recommended}</p>
      </div>
    </HoverCard>
  );
}
