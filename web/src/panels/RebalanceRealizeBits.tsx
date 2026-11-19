import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { PerpSide, Pool, RealizeLeg } from '../api/types';
import { t } from '../i18n';
import { fmtUsd, num } from '../lib/fmt';
import { CONVERT_MAX, CONVERT_TO, MODAL_FEE, MODAL_IMPACT, PLATFORM, poolCoin, poolKey, sideText, sizeText, WALLET_LABEL } from './rebalanceCopy';

export const closeRowText = (leg: { positionQty: number; base: string; side: PerpSide }, part: number): string =>
  t('accounts.rebalanceRealize.closeRow', { part: sizeText(part), total: sizeText(leg.positionQty), base: leg.base, side: sideText(leg.side) });

export interface ActionCost {
  closeFee: number;
  closeImpact: number;
  convertFee: number;
  reopenFee: number;
  reopenImpact: number;
}

export interface ActionLeg {
  symbol: string;
  base: string;
  side: PerpSide;
  pool: Pool;
  positionQty: number;
  closeQty: number;
  reopenQty: number;
  convert: { amount: number; count: number } | null;
  cost: ActionCost | null;
}

export const planActionLeg = (leg: RealizeLeg): ActionLeg => ({
  symbol: leg.symbol,
  base: leg.base,
  side: leg.side,
  pool: leg.pool,
  positionQty: leg.positionQty,
  closeQty: leg.qty,
  reopenQty: leg.qty,
  convert: leg.convert ? { amount: leg.convert.amount, count: leg.convert.count } : null,
  cost: {
    closeFee: leg.closeFeeUsd,
    closeImpact: leg.closeImpactUsd,
    convertFee: leg.convert?.feeUsd ?? 0,
    reopenFee: leg.reopenFeeUsd,
    reopenImpact: leg.reopenImpactUsd,
  },
});

export function FeeCell({ feeUsd, impactUsd }: { feeUsd: number; impactUsd: number }) {
  return (
    <span className="num text-right text-ink-100">
      {MODAL_FEE(fmtUsd(feeUsd))}
      {impactUsd > 0 && <span className="block text-[11px] text-ink-400">{MODAL_IMPACT(fmtUsd(impactUsd))}</span>}
    </span>
  );
}

export function RealizeRow({ legs }: { legs: ActionLeg[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {legs.map((leg) => (
        <div key={leg.symbol} data-realize-row={leg.symbol} className="flex items-start justify-between gap-4 pr-3 text-xs">
          <span className="num min-w-0 text-ink-100">{closeRowText(leg, leg.closeQty)}</span>
          {leg.cost && (
            <FeeCell
              feeUsd={leg.cost.closeFee + leg.cost.reopenFee + leg.cost.convertFee}
              impactUsd={Math.max(0, leg.cost.closeImpact + leg.cost.reopenImpact)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

type Tense = 'plan' | 'past';

interface ActionLine {
  key: string;
  text: ReactNode;
  note: string | null;
  cost: string;
}

const costText = (feeUsd: number, impactUsd: number): string =>
  impactUsd > 0 ? `${fmtUsd(feeUsd)} + ${fmtUsd(impactUsd)}` : fmtUsd(feeUsd);

const PERP_ACTION = {
  close: { plan: 'accounts.rebalanceRealize.closeAction', past: 'accounts.rebalanceRealize.closedDone' },
  reopen: { plan: 'accounts.rebalanceRealize.reopenAction', past: 'accounts.rebalanceRealize.reopenedDone' },
} as const;

function perpAction(leg: ActionLeg, verb: keyof typeof PERP_ACTION, tense: Tense): string {
  const words = { size: sizeText(verb === 'close' ? leg.closeQty : leg.reopenQty), base: leg.base, side: sideText(leg.side) };
  return t(PERP_ACTION[verb][tense], words);
}

function convertNote(pool: Pool, convert: NonNullable<ActionLeg['convert']>): string {
  const note = t('accounts.rebalanceRealize.convertNote', { platform: PLATFORM, coin: poolCoin(CONVERT_TO[pool]) });
  if (convert.count <= 1) return note;
  const split = t('accounts.rebalanceRealize.convertSplit', {
    count: convert.count,
    amount: num(convert.amount / convert.count, 0),
    max: num(CONVERT_MAX, 0),
  });
  return `${note} ${split}`;
}

function convertAction(leg: ActionLeg, convert: NonNullable<ActionLeg['convert']>, tense: Tense): ActionLine {
  const words = { amount: num(convert.amount, 0), coin: poolCoin(leg.pool) };
  const lead = t(tense === 'plan' ? 'accounts.rebalanceRealize.convertAction' : 'accounts.rebalanceRealize.convertedDone', words);
  return {
    key: `${leg.symbol}:convert`,
    text: (
      <>
        {lead}
        <ArrowRight size={12} aria-hidden className="shrink-0 text-ink-500" />
        {WALLET_LABEL[poolKey(CONVERT_TO[leg.pool])]}
      </>
    ),
    note: tense === 'plan' ? convertNote(leg.pool, convert) : null,
    cost: leg.cost ? costText(leg.cost.convertFee, 0) : '',
  };
}

function legActions(leg: ActionLeg, tense: Tense): ActionLine[] {
  const cost = leg.cost;
  const close = { key: `${leg.symbol}:close`, text: perpAction(leg, 'close', tense), note: null, cost: cost ? costText(cost.closeFee, cost.closeImpact) : '' };
  const reopen = { key: `${leg.symbol}:reopen`, text: perpAction(leg, 'reopen', tense), note: null, cost: cost ? costText(cost.reopenFee, cost.reopenImpact) : '' };
  return leg.convert ? [close, convertAction(leg, leg.convert, tense), reopen] : [close, reopen];
}

export function RealizeActions({
  legs,
  open,
  onToggle,
  tense,
}: {
  legs: ActionLeg[];
  open: boolean;
  onToggle: () => void;
  tense: Tense;
}) {
  const listId = useId();
  if (!legs.some((leg) => leg.convert !== null)) return null;
  const actions = legs.flatMap((leg) => legActions(leg, tense));
  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="btn-link num inline-flex items-center gap-1 self-start"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {t('accounts.rebalanceRealize.actionsToggle', { count: actions.length })}
      </button>
      {open && (
        <ol id={listId} className="mt-1.5 flex flex-col gap-1 border-l border-ink-700 pl-2.5 text-[11px] leading-4 text-ink-300">
          {actions.map((action, index) => (
            <li key={action.key} data-action={action.key} className="flex gap-2.5">
              <span className="num w-2 shrink-0">{num(index + 1, 0)}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span data-action-text="" className="num inline-flex flex-wrap items-center gap-1">
                  {action.text}
                </span>
                {action.note && (
                  <span data-action-note="" className="num text-ink-400">
                    {action.note}
                  </span>
                )}
              </span>
              <span className="num shrink-0 text-right">{action.cost}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
