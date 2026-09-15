import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useRebalance, useStartTransfer, useTransfer } from '../api/queries';
import type { GateAccount, TransferCoin, TransferJob, TransferLock, TransferPath } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { HoverCard } from '../components/HoverCard';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { amountError } from '../lib/amount';
import { num, sig } from '../lib/fmt';
import { floorCents, roundToStep } from '../lib/ticks';
import { useNow } from '../lib/useNow';
import { useSettledError } from '../lib/useSettledError';
import { HOVER } from './rebalanceCopy';
import {
  findPath,
  fmtTransferAmount,
  MovingLine,
  NoSpotReadLine,
  SpotTile,
  TransferFacts,
  WalletList,
  coinOf,
  destinationOf,
  type CrossexWallet,
} from './TransferBits';

type Tab = 'into' | 'out';

const TABS: { value: Tab; label: string }[] = [
  { value: 'into', label: 'Into CrossEx' },
  { value: 'out', label: 'Out of CrossEx' },
];

const LOCK_LINE: Record<TransferLock, string> = {
  rebalance: 'Transfers wait until the rebalance ends.',
  halted: 'Transfers wait until you resume or abandon the rebalance.',
  deal: 'Transfers wait until the deal ends.',
};

export interface TransferPick {
  coin: TransferCoin;
  wallet: GateAccount;
  nonce: number;
}

function doneText(transfer: TransferJob): string {
  const sent = `Sent ${num(transfer.amount)} ${transfer.coin} ${destinationOf(transfer.to)}.`;
  return transfer.received === null ? sent : `${sent} ${num(transfer.received)} arrived.`;
}

function parsedAmount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '' || amountError(trimmed) !== null) return null;
  return Number(trimmed);
}

function formatLine(text: string): string | null {
  if (text.includes(',')) return 'Remove the commas.';
  return amountError(text);
}

function limitLine(tab: Tab, path: TransferPath, amount: number | null): string | null {
  if (amount === null) return null;
  if (path.max !== null && amount > path.max) {
    const rest = tab === 'out' ? 'The rest is margin for open positions.' : 'That is your Gate spot balance.';
    return `Max ${num(path.max)} ${path.coin}. ${rest}`;
  }
  if (amount < path.min) return `Minimum ${sig(path.min)} ${path.coin}.`;
  return null;
}

export function TransferSection({ holdMs, pick }: { holdMs?: number; pick?: TransferPick | null }) {
  const [tab, setTab] = useState<Tab>('out');
  const [wallet, setWallet] = useState<CrossexWallet>('CROSSEX');
  const [typed, setTyped] = useState('');
  const query = useTransfer();
  const buckets = useRebalance().data?.buckets;
  const start = useStartTransfer();
  const { push } = useToast();
  const now = useNow(1_000);
  const inputId = useId();
  const appliedNonce = useRef<number | null>(null);
  const seenMoving = useRef(new Set<string>());
  const transfer = query.data?.transfer ?? null;
  const loadError = useSettledError(query.status, query.error);

  useEffect(() => {
    if (!pick || pick.nonce === appliedNonce.current) return;
    appliedNonce.current = pick.nonce;
    if (pick.wallet === 'SPOT') return;
    setTab('into');
    setWallet(pick.wallet);
  }, [pick]);

  useEffect(() => {
    if (!transfer) return;
    const { id } = transfer;
    if (transfer.status === 'moving') {
      seenMoving.current.add(id);
      return;
    }
    if (transfer.status !== 'done' || !seenMoving.current.has(id)) return;
    const text = doneText(transfer);
    const fire = () => {
      if (document.visibilityState !== 'visible' || !seenMoving.current.delete(id)) return;
      push('success', text);
    };
    fire();
    document.addEventListener('visibilitychange', fire);
    return () => document.removeEventListener('visibilitychange', fire);
  }, [transfer, push]);

  const header = (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
        <HoverCard label="Transfer" widthPx={320} underline={false}>
          {HOVER.transferTitle}
        </HoverCard>
      </h2>
      <p className="text-xs text-ink-500">Between Gate spot and CrossEx</p>
    </div>
  );

  const view = query.data;
  if (!view) {
    return (
      <section aria-label="Transfer" className="card flex flex-col gap-3.5 p-4">
        {header}
        {loadError ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-xs text-rose-300">
              Could not load transfers. {loadError.message}
            </p>
            <button type="button" className="btn-ghost-xs leading-4" onClick={() => void query.refetch()}>
              Retry
            </button>
          </div>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </section>
    );
  }

  const coin = coinOf(wallet);
  const from: GateAccount = tab === 'out' ? wallet : 'SPOT';
  const to: GateAccount = tab === 'out' ? 'SPOT' : wallet;
  const path = findPath(view.paths, { coin, from, to });
  const max = path?.max ?? null;
  const moving = transfer?.status === 'moving' ? transfer : null;
  const locked = view.lock !== null;
  const formOff = moving !== null || locked;
  const amount = parsedAmount(typed);
  const problem = formatLine(typed.trim()) ?? (path ? limitLine(tab, path, amount) : null);
  const canSend = !formOff && !start.isPending && path !== undefined && amount !== null && problem === null;
  const holdLabel = `Hold to send ${fmtTransferAmount(amount ?? 0)} ${coin} ${destinationOf(to)}`;

  let status: ReactNode = null;
  if (moving) {
    const movingPath = findPath(view.paths, moving);
    status = <MovingLine transfer={moving} seconds={movingPath?.seconds ?? null} now={now} />;
  } else if (view.lock) {
    status = (
      <p className="rounded border border-info/40 bg-info/10 px-3 py-2 text-xs text-pastel-blue">{LOCK_LINE[view.lock]}</p>
    );
  } else if (transfer?.status === 'failed' && transfer.failText) {
    status = (
      <p role="alert" className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
        {transfer.failText}
      </p>
    );
  }

  const send = () => {
    if (!path || amount === null) return;
    start.mutate({ coin: path.coin, from: path.from, to: path.to, amount: typed.trim() });
  };

  const walletList = (side: 'From' | 'To') => (
    <WalletList side={side} wallet={wallet} buckets={buckets} disabled={locked} onPick={setWallet} />
  );
  const spotTile = (side: 'From' | 'To') => <SpotTile side={side} spot={view.spot} disabled={locked} />;

  return (
    <section aria-label="Transfer" className="card flex flex-col gap-3.5 p-4">
      {header}
      {status}
      {view.spot === null && <NoSpotReadLine />}
      <fieldset disabled={formOff} className="grid min-w-0 gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <SegmentedToggle<Tab>
            ariaLabel="Direction"
            value={tab}
            onChange={setTab}
            options={TABS}
            className={locked ? 'opacity-50' : undefined}
            fill
          />
          {tab === 'out' ? walletList('From') : spotTile('From')}
          {tab === 'out' ? spotTile('To') : walletList('To')}
        </div>
        <div className="flex flex-col gap-3 md:border-l md:border-ink-700 md:pl-6">
          <label htmlFor={inputId} className={`text-xs text-ink-400 ${locked ? 'opacity-50' : ''}`}>
            {'Amount'}
            {max !== null && ' · '}
            {max !== null && (
              <HoverCard label={<span className="num">{`up to ${num(max)}`}</span>} icon={false} widthPx={280}>
                {tab === 'out' ? HOVER.upToOut : HOVER.upToInto}
              </HoverCard>
            )}
          </label>
          <div className="flex items-center gap-2">
            <input
              id={inputId}
              className={`input num w-40 disabled:cursor-not-allowed disabled:opacity-60 ${problem ? '!border-rose-500/60' : ''}`}
              inputMode="decimal"
              aria-invalid={problem ? true : undefined}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                start.reset();
              }}
            />
            {max !== null && (
              <button
                type="button"
                className="btn-ghost-xs leading-4"
                onClick={() => setTyped(roundToStep(floorCents(max), '0.01', 'down'))}
              >
                Max
              </button>
            )}
          </div>
          {path && <TransferFacts path={path} amount={amount ?? 0} showYouGet={!problem} disabled={locked} />}
          {problem && <p className="num text-xs text-rose-300">{problem}</p>}
          <HoldToConfirmButton tone="cyan" holdMs={holdMs} disabled={!canSend} onConfirm={send} className="num self-start">
            {holdLabel}
          </HoldToConfirmButton>
          {start.error && (
            <p role="alert" className="num text-xs text-rose-300">
              {start.error.message}
              {start.error instanceof ApiError && start.error.hint ? (
                <span className="block text-rose-400/80">{start.error.hint}</span>
              ) : null}
            </p>
          )}
        </div>
      </fieldset>
    </section>
  );
}
