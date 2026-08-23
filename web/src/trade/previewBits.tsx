/** Shared render helpers for preview estimates (ticket, pair, basket, review). */
import type {
  ActionInput,
  CrossexPosition,
  FeeEstimate,
  FillEstimate,
  PreviewResult,
  Violation,
} from '../api/types';
import { Chip } from '../components/Chip';
import { SideChip } from '../components/VenueChip';
import { SignedNumber } from '../components/SignedNumber';
import { bps, fmtUsd, parseSymbol, sig } from '../lib/fmt';

/** Slippage severity coloring: green < 0.05%, amber < 0.3%, red above. */
export function slippageClass(pct: number): string {
  const a = Math.abs(pct);
  return a < 0.05 ? 'text-emerald-400' : a < 0.3 ? 'text-amber-400' : 'text-rose-400';
}

/** Colored slippage % with the estimate provenance in a tooltip. */
export function SlippageBadge({ est }: { est: FillEstimate }) {
  return (
    <span title={`${est.source} · ${est.confidence}`} className={`num ${slippageClass(est.slippagePct)}`}>
      {est.slippagePct >= 0 ? '+' : ''}
      {est.slippagePct.toFixed(3)}%
    </span>
  );
}

/** "0.049 USDT (taker, 5.0 bps)" · "0.02 USDT (maker-only, 2.0 bps)" · maker–taker range. */
export function feeText(fees: FeeEstimate | undefined): string {
  if (!fees) return '—';
  const { est, quote } = fees;
  if (est.maker !== undefined && est.taker !== undefined) {
    return `${sig(est.maker)}–${sig(est.taker)} ${quote} (maker–taker)`;
  }
  if (est.taker !== undefined) return `${sig(est.taker)} ${quote} (taker, ${bps(fees.takerRate)})`;
  if (est.maker !== undefined) return `${sig(est.maker)} ${quote} (maker-only, ${bps(fees.makerRate)})`;
  return '—';
}

/** Single number used for fee totals (taker when crossing, maker otherwise). */
export function estFeeOf(p: PreviewResult): number {
  return p.fees?.est.taker ?? p.fees?.est.maker ?? 0;
}

/** Violations (red, blocking) + warnings (dim) as a compact list. */
export function ViolationList({ violations, warnings }: { violations: Violation[]; warnings?: string[] }) {
  if (!violations.length && !(warnings ?? []).length) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-[11px]">
      {violations.map((v, i) => (
        <li key={`v-${i}`} className="text-rose-400">
          ✕ {v.message}
        </li>
      ))}
      {(warnings ?? []).map((w, i) => (
        <li key={`w-${i}`} className="text-ink-500">
          {w}
        </li>
      ))}
    </ul>
  );
}

/** Preview-box tail while no preview is available: error text or "previewing…". */
export function PreviewFallback({ isError, error }: { isError: boolean; error: unknown }) {
  return isError ? (
    <span className="text-rose-400">preview failed: {(error as Error).message}</span>
  ) : (
    <span className="text-ink-500">previewing…</span>
  );
}

/** BUY (green) / SELL (red) / CLOSE (amber) action chip, with ⛓ for pair legs. */
export function ActionKindChip({ input }: { input: ActionInput }) {
  return (
    <span className="inline-flex items-center gap-1">
      {input.kind === 'close-position' ? <Chip sm tone="amber">CLOSE</Chip> : <SideChip side={input.side} />}
      {input.pairGroupId && (
        <span title="pair-linked leg (unhedged guard armed)" className="text-[10px] text-cyan-400">
          ⛓
        </span>
      )}
    </span>
  );
}

/** Human description of an ActionInput (remediation buttons, review rows). */
export function describeAction(a: ActionInput): string {
  const { exchange, base } = parseSymbol(a.symbol);
  if (a.kind === 'close-position') {
    const qty = a.qty ? `${sig(a.qty)} ` : '';
    const slip = a.slippagePct !== undefined ? ` (±${a.slippagePct}%)` : '';
    return `close ${qty}${base} on ${exchange}${slip}`;
  }
  const qty = a.qty ? sig(a.qty) : a.notional ? `$${a.notional}` : '?';
  const px = a.kind === 'open-limit' ? ` @ ${a.price}` : '';
  return `${a.side} ${qty} ${base} on ${exchange}${px}`;
}

/**
 * Estimated margin the basket will consume: Σ estNotional / leverage over the OPEN
 * legs only — reduce-only (close) legs FREE margin, so counting them would make an
 * underwater account (the one that most needs to close) look margin-blocked.
 * leverage = the action's requested leverage, else the symbol's CURRENT position
 * leverage, else 1x (worst case). `confident` is false when any counted leg had to
 * fall back to 1x (no requested and no live position leverage) — the number is still
 * shown, but blocking on it would risk a false block, so callers must not gate on it.
 */
export function estimateMargin(
  previews: PreviewResult[],
  positions: CrossexPosition[] | undefined,
): { required: number; confident: boolean } {
  let required = 0;
  let confident = true;
  for (const p of previews) {
    if (p.reduceOnly) continue; // a close consumes no margin
    const posLev = Number(positions?.find((x) => x.symbol === p.symbol)?.leverage);
    const known = p.leverage?.requested || (Number.isFinite(posLev) && posLev > 0 ? posLev : 0);
    if (!known) confident = false; // fell back to 1x worst case
    required += p.estNotional / (known || 1);
  }
  return { required, confident };
}

/**
 * What a close is about to do, rendered IN the form rather than on hover.
 *
 * A close dialog that hides its own numbers behind a hover card asks the user
 * to commit before they can read the price, the fee and the PnL they are
 * realising — and on touch there is no hover at all. `ClosePopover` already
 * inlined this for a single leg; this is the same panel, for any number of
 * legs, so the pair and Boros forms cannot drift from it.
 *
 * One row per leg: side and size, the marketable-limit price, the PnL that
 * becomes real, and the estimated fee. Violations and warnings ride underneath
 * because they are about the basket, not any one leg.
 */
export function ClosePreviewPanel({
  previews,
  estimating,
  isError,
  error,
  labelFor,
  realizedFor,
  note,
}: {
  previews: PreviewResult[] | undefined;
  estimating: boolean;
  isError: boolean;
  error: unknown;
  /** How to name a leg — the venue and market, in the caller's own words. */
  labelFor: (p: PreviewResult, i: number) => string;
  /** PnL this leg realises, when the caller can compute it. */
  realizedFor?: (p: PreviewResult, i: number) => number | null;
  note?: string;
}) {
  if (!previews || previews.length === 0) {
    return (
      <div className="rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2.5 text-[11px]">
        <PreviewFallback isError={isError} error={error} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2.5 text-[11px]">
      {estimating && <span className="text-amber-400">estimating…</span>}
      {previews.map((p, i) => {
        const realized = realizedFor?.(p, i) ?? null;
        return (
          <div key={`${p.symbol ?? i}`} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-ink-300">
              <SideChip side={p.side} />
              <span className="text-ink-200">{labelFor(p, i)}</span>
              <span className="num ml-auto text-ink-100">{p.qty ? sig(p.qty) : '—'}</span>
            </span>
            <span className="flex justify-between text-ink-400">
              <span>marketable limit px</span>
              <span className="num text-ink-100">{p.price ? sig(p.price) : '—'}</span>
            </span>
            {p.fillEstimate && (
              <span className="flex items-center justify-between text-ink-400">
                <span>slippage</span>
                <SlippageBadge est={p.fillEstimate} />
              </span>
            )}
            {realized !== null && (
              <span className="flex justify-between text-ink-400">
                <span>PnL realised</span>
                <SignedNumber value={realized} format={(n) => fmtUsd(n)} />
              </span>
            )}
            <span className="flex justify-between text-ink-400">
              <span>est fee</span>
              <span className="text-ink-200">{feeText(p.fees)}</span>
            </span>
          </div>
        );
      })}
      {note && <span className="cursor-help text-ink-500" title={note}>reduce-only IOC marketable limit ⓘ</span>}
      <ViolationList
        violations={previews.flatMap((p) => p.violations ?? [])}
        warnings={previews.flatMap((p) => p.warnings ?? [])}
      />
    </div>
  );
}
