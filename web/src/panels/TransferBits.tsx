import { useId, type ReactNode } from 'react';
import type { GateAccount, RebalanceBucket, SpotBalance, TransferCoin, TransferJob, TransferPath } from '../api/types';
import { HoverCard } from '../components/HoverCard';
import { microLabelClass } from '../components/Th';
import { fmtAbout, fmtAge, fmtUsd, num, sig } from '../lib/fmt';
import { roundToStep, stripZeros } from '../lib/ticks';
import { Ext, GATE_API_KEYS_URL, PERMISSION_ROWS } from './onboardingBits';
import { ProgressBar } from './RebalanceBits';
import { keyOf, Term } from './RebalanceHovers';
import { HOVER, WALLET_LABEL } from './rebalanceCopy';

export type CrossexWallet = Exclude<GateAccount, 'SPOT'>;

const WALLET: Record<CrossexWallet, { coin: TransferCoin; venue: string }> = {
  CROSSEX: { coin: 'USDT', venue: 'CROSSEX' },
  CROSSEX_GATE: { coin: 'USDC', venue: 'GATE' },
  CROSSEX_HYPERLIQUID: { coin: 'USDC', venue: 'HYPERLIQUID' },
};

const WALLET_ORDER: CrossexWallet[] = ['CROSSEX', 'CROSSEX_GATE', 'CROSSEX_HYPERLIQUID'];

export function coinOf(wallet: CrossexWallet): TransferCoin {
  return WALLET[wallet].coin;
}

export function destinationOf(to: GateAccount): string {
  return to === 'SPOT' ? 'to Gate spot' : 'into CrossEx';
}

export function WalletList({
  side,
  wallet,
  buckets,
  onPick,
}: {
  side: 'From' | 'To';
  wallet: CrossexWallet;
  buckets: RebalanceBucket[] | undefined;
  onPick: (next: CrossexWallet) => void;
}) {
  const headerId = useId();
  const groupName = useId();
  return (
    <div role="radiogroup" aria-labelledby={headerId} className="flex flex-col gap-1.5">
      <span id={headerId} className="text-xs text-ink-400">
        {`${side} · CrossEx wallet`}
      </span>
      {WALLET_ORDER.map((account) => {
        const { coin, venue } = WALLET[account];
        const label = WALLET_LABEL[keyOf({ coin, venue })];
        const cash = buckets ? (buckets.find((b) => b.coin === coin && b.venue === venue)?.cash ?? 0) : null;
        const picked = account === wallet;
        return (
          <label
            key={account}
            className={`flex min-h-[38px] cursor-pointer items-center gap-3 rounded border px-3 py-1.5 text-xs ${
              picked ? 'border-info bg-info/10' : 'border-ink-700'
            }`}
          >
            <input
              type="radio"
              name={groupName}
              className="chk"
              aria-label={label}
              checked={picked}
              onChange={() => onPick(account)}
            />
            <span className="flex-1 font-semibold text-ink-100">{label}</span>
            {cash !== null && <span className="num text-ink-200">{`${num(cash)} ${coin}`}</span>}
          </label>
        );
      })}
    </div>
  );
}

function spotAvailable(spot: SpotBalance[], coin: TransferCoin): number {
  return spot.find((row) => row.coin === coin)?.available ?? 0;
}

export function SpotTile({ side, spot }: { side: 'From' | 'To'; spot: SpotBalance[] | null }) {
  const headerId = useId();
  return (
    <div role="group" aria-labelledby={headerId} className="flex flex-col gap-1.5">
      <span id={headerId} className="text-xs text-ink-400">
        {side}
      </span>
      <div className="flex flex-col items-start gap-1 rounded border border-dashed border-gold/40 px-3 py-2.5 text-xs">
        <HoverCard label="Gate spot" icon={false} widthPx={200}>
          {HOVER.gateSpot}
        </HoverCard>
        <span className="num text-ink-400">
          {spot ? `${num(spotAvailable(spot, 'USDT'))} USDT · ${num(spotAvailable(spot, 'USDC'))} USDC` : 'balance hidden'}
        </span>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className={microLabelClass}>{label}</dt>
      <dd className="num text-sm text-ink-100">{value}</dd>
    </div>
  );
}

const SERVER_TRANSFER_STEP = '0.00001';

export function fmtTransferAmount(value: number): string {
  const floored = stripZeros(roundToStep(value, SERVER_TRANSFER_STEP, 'down'));
  const [whole, frac = ''] = floored.split('.');
  return frac.length >= 2 ? floored : `${whole}.${frac.padEnd(2, '0')}`;
}

export function TransferFacts({
  path,
  amount,
  showYouGet = true,
}: {
  path: TransferPath;
  amount: number;
  showYouGet?: boolean;
}) {
  return (
    <dl className="grid w-fit grid-cols-2 gap-x-7 gap-y-3">
      <Fact label={<Term label="Fee" text={HOVER.fee} />} value={path.feeUsd === 0 ? 'free' : fmtUsd(path.feeUsd)} />
      <Fact label={<Term label="Time" text={HOVER.time} />} value={fmtAbout(path.seconds)} />
      {path.min >= 1 && (
        <Fact label={<Term label="Minimum" text={HOVER.minimum} />} value={`${sig(path.min)} ${path.coin}`} />
      )}
      {showYouGet && (
        <Fact label="You get" value={`${fmtTransferAmount(Math.max(0, amount - path.feeUsd))} ${path.coin}`} />
      )}
    </dl>
  );
}

export function MovingLine({ transfer, seconds, now }: { transfer: TransferJob; seconds: number | null; now: number }) {
  const elapsedMs = Math.max(0, now - transfer.createdAt);
  const elapsed = fmtAge(elapsedMs);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded border border-info/40 bg-info/10 px-3 py-2 text-xs"
    >
      <span className="num text-pastel-blue">
        {`Sending ${num(transfer.amount)} ${transfer.coin} ${destinationOf(transfer.to)}`}
      </span>
      <div className="w-24">
        <ProgressBar ratio={seconds ? elapsedMs / (seconds * 1000) : 0} tone="running" />
      </div>
      <span className="num text-ink-200">{seconds === null ? elapsed : `${elapsed} of ${fmtAbout(seconds)}`}</span>
    </div>
  );
}

export function NoSpotReadLine() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-dashed border-ink-600 px-3 py-2 text-xs">
      <span className="text-ink-200">Add Spot read permission to see spot balances.</span>
      <HoverCard
        label={<span className="text-link">How ▸</span>}
        icon={false}
        underline={false}
        widthPx={400}
      >
        <div className="flex flex-col gap-2 text-xs">
          <Ext href={GATE_API_KEYS_URL}>API Management</Ext>
          <ul className="flex flex-col gap-1">
            {PERMISSION_ROWS.map((row) => (
              <li key={row.label} className="grid grid-cols-3 gap-2">
                <span className="font-semibold text-ink-100">{row.label}</span>
                <span className="text-ink-200">{row.value}</span>
                <span className="text-ink-400">{row.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </HoverCard>
    </div>
  );
}
