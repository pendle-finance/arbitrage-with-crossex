import { useState, type ReactNode } from 'react';
import { useAccount, usePositions, useRebalance, useRebalanceCommand, useStartRebalance, useTransfer } from '../api/queries';
import type { GateAccount, RouteName, TransferCoin, WalletAfter } from '../api/types';
import { Chip } from '../components/Chip';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { borrowedBucket, MIN_BORROW } from '../lib/borrow';
import { fmtAbout, fmtAge, num } from '../lib/fmt';
import { floorCents } from '../lib/ticks';
import { useNow } from '../lib/useNow';
import { useSettledError } from '../lib/useSettledError';
import { BalanceBars, BarLegend, jobRows, planRows, ROUND_SECONDS, StepList, type BarRow } from './RebalanceBits';
import { HOVER } from './rebalanceCopy';
import { borrowFacts, cashFacts, DUST, Facts, lastRunFacts, quoteFacts, RebalanceInfo, ROUTE_LABEL } from './RebalanceHovers';
import { keyOf, roundCountOf, RouteRow, SpotLines, Term, toggleLabel, WalletTerm } from './RebalanceHovers';

const ROUTE_ORDER: RouteName[] = ['mix', 'loop', 'convert'];
const WALLET_TONE: Record<string, BarRow['tone']> = { 'USDT/CROSSEX': 'usdt', 'USDC/HYPERLIQUID': 'usdc', 'USDC/GATE': 'gate' };

const scaleOf = (...sets: BarRow[][]) => Math.max(0, ...sets.flat().map((row) => Math.abs(row.cash + row.gain)));

function barRows(wallets: WalletAfter[], showGate: boolean): BarRow[] {
  return Object.keys(WALLET_TONE)
    .filter((key) => showGate || key !== 'USDC/GATE')
    .flatMap((key): BarRow[] => {
      const w = wallets.find((wallet) => keyOf(wallet) === key);
      if (!w) return [];
      return [{ key, label: <WalletTerm wallet={key} />, cash: w.cash, gain: w.equity - w.cash, tone: WALLET_TONE[key] }];
    });
}

function CommandButton({ name, text, disabled, onPress }: { name: string; text: string; disabled: boolean; onPress: () => void }) {
  const rule = (
    <span className="h-1.5 w-full">
      <span className="sr-only">{`About ${name}`}</span>
    </span>
  );
  return (
    <span className="inline-flex flex-col">
      <button type="button" className="btn-ghost-xs" disabled={disabled} onClick={onPress}>
        {name}
      </button>
      <Term label={rule} text={text} />
    </span>
  );
}

export function RebalanceSection({
  holdMs,
  onTransfer,
}: {
  holdMs?: number;
  onTransfer?: (coin: TransferCoin, wallet: GateAccount) => void;
}) {
  const query = useRebalance();
  const transfer = useTransfer().data;
  const account = useAccount().data;
  const positions = usePositions().data;
  const start = useStartRebalance();
  const resume = useRebalanceCommand('resume');
  const abandon = useRebalanceCommand('abandon');
  const toast = useToast();
  const now = useNow();
  const [chosen, setChosen] = useState<{ key: string; route: RouteName } | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  const loadError = useSettledError(query.status, query.error);
  const view = query.data;
  const title = (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
      <RebalanceInfo />
    </h2>
  );

  if (!view) {
    if (!loadError) return null;
    return (
      <section aria-label="Rebalance" className="card flex flex-col gap-2 p-4">
        {title}
        <p role="alert" className="text-xs text-rose-300">
          Could not load the rebalance view. {loadError.message}
        </p>
        <button type="button" className="btn-ghost-xs self-start" onClick={() => void query.refetch()}>
          Retry
        </button>
      </section>
    );
  }

  const { plan, job, buckets } = view;
  const onError = (error: Error) => toast.push('error', error.message);
  const mode = job?.status === 'running' || job?.status === 'halted' ? job.status : plan.balanced ? 'balanced' : 'plan';
  const runKey = [job?.id, job?.status, plan.direction, plan.recommended].join(':');
  const isOpen = (name: RouteName | null): name is RouteName => name !== null && plan.routes[name]?.available === true;
  const pick = [chosen?.key === runKey ? chosen.route : null, plan.recommended, ...ROUTE_ORDER].find(isOpen) ?? null;
  const route = plan.routes[pick ?? plan.recommended ?? 'convert'] ?? plan.routes.convert;
  const direction = job && (mode === 'running' || mode === 'halted') ? job.direction : (plan.direction ?? 'toUsdc');
  const showGate = Math.abs(buckets.find((b) => keyOf(b) === 'USDC/GATE')?.cash ?? 0) >= DUST;
  const borrowed = borrowedBucket(buckets);
  const receiving = buckets.find((b) => keyOf(b) === (direction === 'toUsdt' ? 'USDT/CROSSEX' : 'USDC/HYPERLIQUID'));
  const borrow = receiving && floorCents(receiving.borrow) >= MIN_BORROW ? receiving.borrow : null;
  const moving = transfer?.transfer?.status === 'moving';
  const nowCaption = <Term label="Now" text={HOVER.now} />;
  const nowRows = barRows(buckets, showGate);
  const currentRound = job?.steps[job.stepIndex]?.round ?? null;
  const withSpot = (key: string, label: string, text: string): BarRow[] =>
    job?.inTransit
      ? [...nowRows, { key, label: <Term label={label} text={text} />, cash: job.inTransit.qty, gain: 0, tone: 'spot' }]
      : nowRows;
  const hold = (
    <HoldToConfirmButton
      tone="cyan"
      holdMs={holdMs}
      disabled={mode !== 'plan' || moving || pick === null || start.isPending}
      onConfirm={() => pick && start.mutate({ route: pick }, { onError })}
    >
      Hold to rebalance
    </HoldToConfirmButton>
  );
  const spotLines = <SpotLines transfer={transfer} job={job} onTransfer={onTransfer} />;

  let body: ReactNode;
  if (job && mode === 'running') {
    const rounds = roundCountOf(job);
    const total = rounds * ROUND_SECONDS[job.direction];
    const elapsed = fmtAge(Math.max(0, now - job.createdAt));
    const rows = withSpot('transit', 'On the way', HOVER.onTheWay);
    const target = job.target ? barRows(job.target, showGate) : [];
    const roundFact = { key: 'round', label: 'Round', value: `${num(currentRound ?? 0, 0)} of ${num(rounds, 0)}` };
    body = (
      <>
        <Facts
          items={[
            { key: 'route', label: 'Route', value: ROUTE_LABEL[job.route] },
            ...(currentRound === null ? [] : [roundFact]),
            { key: 'time', label: 'Time', value: total > 0 ? `${elapsed} of ${fmtAbout(total)}` : elapsed },
          ]}
        />
        <div className="grid grid-cols-2 gap-8 border-t border-ink-800 pt-3">
          <BalanceBars caption={nowCaption} rows={rows} scale={scaleOf(rows, target)} />
          {target.length > 0 && <BalanceBars caption="After rebalance" rows={target} scale={scaleOf(rows, target)} />}
        </div>
        <BarLegend rows={[...rows, ...target]} />
        <StepList rows={jobRows(job, now, borrow)} />
        <p className="text-xs text-ink-400">New deals and transfers wait until it ends.</p>
      </>
    );
  } else if (job && mode === 'halted') {
    const rows = withSpot('spot', 'Gate spot', HOVER.gateSpot);
    const busy = resume.isPending || abandon.isPending;
    body = (
      <>
        <div role="alert" className="num flex flex-col gap-0.5 text-sm text-rose-300">
          <p className="font-semibold">
            {currentRound === null ? 'Stopped at Convert.' : `Stopped in round ${num(currentRound, 0)}.`}
          </p>
          {job.haltReason && <p>{job.haltReason}</p>}
        </div>
        <div className="grid grid-cols-2 gap-8">
          <BalanceBars caption="Where your money is" rows={rows} scale={scaleOf(rows)} />
        </div>
        <BarLegend rows={rows} />
        <div className="flex gap-2">
          <CommandButton name="Resume" text={HOVER.resume} disabled={busy} onPress={() => resume.mutate(job.id, { onError })} />
          <CommandButton name="Abandon" text={HOVER.abandon} disabled={busy} onPress={() => abandon.mutate(job.id, { onError })} />
        </div>
        <StepList rows={jobRows(job, now, borrow)} />
      </>
    );
  } else if (mode === 'balanced') {
    body = (
      <>
        <div className="grid grid-cols-2 gap-8">
          <BalanceBars caption={nowCaption} rows={nowRows} scale={scaleOf(nowRows)} />
        </div>
        <BarLegend rows={nowRows} />
        <Facts items={lastRunFacts(job)} />
        <div>{hold}</div>
        {spotLines}
      </>
    );
  } else {
    const afterRows = barRows(route.after, showGate);
    body = (
      <>
        <Facts items={borrowFacts(buckets)} />
        <div className="grid grid-cols-2 gap-8 border-t border-ink-800 pt-3">
          <BalanceBars caption={nowCaption} rows={nowRows} scale={scaleOf(nowRows, afterRows)} />
          <BalanceBars caption="After rebalance" rows={afterRows} scale={scaleOf(nowRows, afterRows)} />
        </div>
        <BarLegend rows={[...nowRows, ...afterRows]} />
        <Facts items={cashFacts(plan)} />
        <div className="flex flex-col gap-2">
          <div className={microLabelClass}>
            <Term label="Route" text={HOVER.route} />
          </div>
          <div role="radiogroup" aria-label="Route" className="flex flex-col gap-1.5">
            {ROUTE_ORDER.map((name) => (
              <RouteRow
                key={name}
                route={name}
                plan={plan}
                borrow={borrow}
                checked={pick === name}
                onPick={() => setChosen({ key: runKey, route: name })}
              />
            ))}
          </div>
        </div>
        <Facts items={quoteFacts({ route, borrow, buckets, account, positions })} />
        {route.steps.length > 0 && (
          <button
            type="button"
            className="btn-link inline-flex items-center gap-1 self-start"
            aria-expanded={stepsOpen}
            onClick={() => setStepsOpen(!stepsOpen)}
          >
            <span aria-hidden="true">▸</span>
            {stepsOpen ? 'Hide' : toggleLabel(route)}
          </button>
        )}
        {stepsOpen && <StepList rows={planRows(route, direction, borrow)} />}
        <div className="flex flex-wrap items-center gap-3">
          {hold}
          {plan.shortOfEven > 0 && <Chip tone="amber">Ends as even as cash allows</Chip>}
        </div>
        <p className="text-xs text-ink-400">
          {moving ? 'Rebalance waits until the transfer ends.' : 'New deals and transfers wait until it ends.'}
        </p>
        {spotLines}
      </>
    );
  }

  return (
    <section aria-label="Rebalance" className="card flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          {title}
          <p className="text-xs text-ink-500">Even out your CrossEx USDT and USDC wallets</p>
        </div>
        {mode === 'balanced' && <Chip tone="green">Balanced</Chip>}
        {mode !== 'balanced' && borrowed && (
          <Chip tone="amber">
            <span className="num">{`Borrowing ${num(floorCents(borrowed.borrow))} ${borrowed.coin}`}</span>
          </Chip>
        )}
      </div>
      {body}
    </section>
  );
}
