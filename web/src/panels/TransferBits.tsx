import { useId } from 'react';
import type { GateAccount, RebalanceBucket, SpotBalance, TransferCoin, TransferJob, TransferPath } from '../api/types';
import { HoverCard } from '../components/HoverCard';
import { RadioRow } from '../components/RadioRow';
import { fmtAbout, fmtAge, fmtUsd, num, sig } from '../lib/fmt';
import { roundToStep, stripZeros } from '../lib/ticks';
import { Ext, GATE_API_KEYS_URL, PERMISSION_ROWS } from './onboardingBits';
import { ProgressBar } from './RebalanceBits';
import { Facts, keyOf, Term, type Fact } from './RebalanceHovers';
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
  return to === 'SPOT' ? 'to Gate spot' : `to ${WALLET_LABEL[keyOf(WALLET[to])]}`;
}

export function WalletList({
  side,
  wallet,
  buckets,
  disabled,
  onPick,
}: {
  side: 'From' | 'To';
  wallet: CrossexWallet;
  buckets: RebalanceBucket[] | undefined;
  disabled: boolean;
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
        const labelId = `${groupName}${account}`;
        const cash = buckets ? (buckets.find((b) => b.coin === coin && b.venue === venue)?.cash ?? 0) : null;
        return (
          <RadioRow
            key={account}
            name={groupName}
            labelledBy={labelId}
            checked={account === wallet}
            disabled={disabled}
            onPick={() => onPick(account)}
          >
            <span id={labelId} className="flex-1 font-semibold text-ink-100">
              {WALLET_LABEL[keyOf({ coin, venue })]}
            </span>
            {cash !== null && <span className="num text-ink-200">{`${num(cash)} ${coin}`}</span>}
          </RadioRow>
        );
      })}
    </div>
  );
}

function spotAvailable(spot: SpotBalance[], coin: TransferCoin): number {
  return spot.find((row) => row.coin === coin)?.available ?? 0;
}

export function SpotTile({ side, spot, disabled }: { side: 'From' | 'To'; spot: SpotBalance[] | null; disabled: boolean }) {
  const headerId = useId();
  return (
    <div role="group" aria-labelledby={headerId} className={`flex flex-col gap-1.5 ${disabled ? 'opacity-50' : ''}`}>
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

const SERVER_TRANSFER_STEP = '0.00001';

export function fmtTransferAmount(value: number): string {
  const floored = stripZeros(roundToStep(value, SERVER_TRANSFER_STEP, 'down'));
  const [whole, frac = ''] = floored.split('.');
  return `${num(Number(whole), 0)}.${frac.padEnd(2, '0')}`;
}

export function TransferFacts({
  path,
  amount,
  showYouGet,
  disabled,
}: {
  path: TransferPath;
  amount: number;
  showYouGet: boolean;
  disabled: boolean;
}) {
  const items: Fact[] = [
    { key: 'fee', label: <Term label="Fee" text={HOVER.fee} />, value: path.feeUsd === 0 ? 'free' : fmtUsd(path.feeUsd) },
    { key: 'time', label: <Term label="Time" text={HOVER.time} />, value: fmtAbout(path.seconds) },
  ];
  if (path.min >= 1) {
    items.push({ key: 'min', label: <Term label="Minimum" text={HOVER.minimum} />, value: `${sig(path.min)} ${path.coin}` });
  }
  if (showYouGet) {
    items.push({ key: 'get', label: 'You get', value: `${fmtTransferAmount(Math.max(0, amount - path.feeUsd))} ${path.coin}` });
  }
  return <Facts items={items} className={`grid w-fit grid-cols-2 gap-x-7 gap-y-3 ${disabled ? 'opacity-50' : ''}`} />;
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

export function NoSpotReadHow() {
  return (
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
        <NoSpotReadHow />
      </HoverCard>
    </div>
  );
}

export function findPath(
  paths: TransferPath[],
  move: { from: GateAccount; to: GateAccount; coin?: TransferCoin },
): TransferPath | undefined {
  return paths.find((p) => p.from === move.from && p.to === move.to && (move.coin === undefined || p.coin === move.coin));
}
