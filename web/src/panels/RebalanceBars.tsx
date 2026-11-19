import { useId, type ReactNode } from 'react';
import { ChartTooltip } from '../components/ChartTooltip';
import { SignedNumber } from '../components/SignedNumber';
import { microLabelClass } from '../components/Th';
import { num } from '../lib/fmt';
import { hoverCash, hoverTarget, hoverUpnl } from './rebalanceCopy';

const HOVER_WIDTH_PX = 268;

type BarTone = 'usdt' | 'usdc' | 'lighter' | 'gate' | 'spot';

export interface BarRow {
  key: string;
  label: ReactNode;
  name?: string;
  cash: number;
  upnl: number;
  target: number | null;
  tone: BarTone;
}

export const WALLET_TONE: Record<string, BarTone> = {
  'USDT/CROSSEX': 'usdt',
  'USDC/HYPERLIQUID': 'usdc',
  'USDC/LIGHTER': 'lighter',
  'USDC/GATE': 'gate',
};

export const ALWAYS_SHOWN = ['USDT/CROSSEX', 'USDC/HYPERLIQUID'];

const barEnds = (row: BarRow): number[] => [row.cash, row.cash + row.upnl, row.target ?? 0];

const widestEnd = (rows: BarRow[]): number => Math.max(0, ...rows.flatMap(barEnds).map((end) => Math.abs(end)));

export const scaleOf = (...sets: BarRow[][]) => widestEnd(sets.flat());

const cashFill = (row: BarRow): string => {
  if (row.tone === 'spot') return 'bg-gold';
  return row.cash >= 0 ? 'bg-grass' : 'bg-guava';
};

const pnlFill = (upnl: number): string => (upnl >= 0 ? 'bar-pnl-gain' : 'bar-pnl-loss');

interface BarParts {
  equity: number;
  zero: number;
  cashLeft: number;
  cashWidth: number;
  pnlLeft: number;
  pnlWidth: number;
  target: number | null;
}

function scalePoint(rows: BarRow[], scale: number): (value: number) => number {
  const half = Math.max(scale, widestEnd(rows));
  if (half <= 0) return () => 50;
  return (value) => Math.min(100, Math.max(0, 50 + (value * 50) / half));
}

function barParts(row: BarRow, at: (value: number) => number): BarParts {
  const equity = row.cash + row.upnl;
  const cashLeft = at(Math.min(0, row.cash));
  const pnlLeft = at(Math.min(row.cash, equity));
  return {
    equity,
    zero: at(0),
    cashLeft,
    cashWidth: at(Math.max(0, row.cash)) - cashLeft,
    pnlLeft,
    pnlWidth: at(Math.max(row.cash, equity)) - pnlLeft,
    target: row.target === null ? null : at(row.target),
  };
}

const cssPct = (value: number): string => `${value}%`;

function WalletHover({ row }: { row: BarRow }) {
  return (
    <div className="flex flex-col gap-2 text-xs" style={{ width: HOVER_WIDTH_PX }}>
      <span className="font-semibold text-ink-50">{row.name ?? row.label}</span>
      <div aria-hidden className="h-px bg-ink-700" />
      <div className="flex items-center gap-2.5">
        <span aria-hidden data-swatch="cash" className={`h-2.5 w-2.5 shrink-0 rounded-sm ${cashFill(row)}`} />
        <span className="text-ink-400">{hoverCash()}</span>
        <span className={`num ml-auto ${row.cash < 0 ? 'text-guava' : 'text-ink-100'}`}>{num(row.cash)}</span>
      </div>
      <div className="flex items-center gap-2.5">
        <span aria-hidden data-swatch="pnl" className={`h-2.5 w-2.5 shrink-0 rounded-sm ${pnlFill(row.upnl)}`} />
        <span className="text-ink-400">{hoverUpnl()}</span>
        <SignedNumber value={row.upnl} className="ml-auto" />
      </div>
      {row.target !== null && (
        <div className="flex items-center gap-2.5">
          <span aria-hidden data-swatch="target" className="mx-1 h-2.5 w-0.5 shrink-0 bg-gold" />
          <span className="text-ink-400">{hoverTarget()}</span>
          <span className="num ml-auto text-gold">{num(row.target)}</span>
        </div>
      )}
    </div>
  );
}

function WalletBar({ row, parts }: { row: BarRow; parts: BarParts }) {
  return (
    <div className="grid min-w-0 flex-1">
      <ChartTooltip content={<WalletHover row={row} />}>
        <div className="relative h-3 w-full">
          <div className="absolute inset-0 overflow-hidden rounded-sm bg-ink-950">
            <div
              aria-hidden
              data-bar-cash=""
              className={`absolute inset-y-0 ${cashFill(row)}`}
              style={{ left: cssPct(parts.cashLeft), width: cssPct(parts.cashWidth) }}
            />
            <div
              aria-hidden
              data-bar-pnl=""
              className={`absolute inset-y-0 z-0 ${pnlFill(row.upnl)}`}
              style={{ left: cssPct(parts.pnlLeft), width: cssPct(parts.pnlWidth) }}
            />
          </div>
          <div
            aria-hidden
            data-zero-line=""
            className="pointer-events-none absolute -inset-y-[5px] z-10 w-px -translate-x-1/2 bg-ink-200"
            style={{ left: cssPct(parts.zero) }}
          />
          {parts.target !== null && (
            <div
              aria-hidden
              data-bar-target=""
              className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-px bg-gold"
              style={{ left: cssPct(parts.target) }}
            />
          )}
        </div>
      </ChartTooltip>
    </div>
  );
}

export function BalanceBars({ caption, rows, scale }: { caption: ReactNode; rows: BarRow[]; scale: number }) {
  const captionId = useId();
  const at = scalePoint(rows, scale);
  return (
    <div role="group" aria-labelledby={captionId} className="flex flex-col gap-2">
      <div id={captionId} className={`h-4 ${microLabelClass}`}>
        {caption}
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const parts = barParts(row, at);
          return (
            <div key={row.key} data-bar-row={row.key} className="flex h-4 items-center gap-3 text-xs">
              <div className="w-40 shrink-0 whitespace-nowrap text-ink-100">{row.label}</div>
              <WalletBar row={row} parts={parts} />
              <span className={`num w-20 shrink-0 text-right ${parts.equity < 0 ? 'text-guava' : 'text-ink-100'}`}>
                {num(parts.equity)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
