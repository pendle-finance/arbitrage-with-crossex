import { ArrowRight, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PriceImpactPreview, TwapPlanPreview, TwapPlanView, TwapRefusalView } from '../api/types';
import { HoverCard } from '../components/HoverCard';
import { Switch } from '../components/Switch';
import { localizeServerText } from '../i18n/serverMessages';
import { fmtUsd, sigGrouped } from '../lib/fmt';
import { parseSpan, spanText } from '../lib/span';
import { AffixedInput } from './PairTicketBits';

export interface TwapInput {
  durationSec?: number;
  intervalSec?: number;
  sliceQty?: string;
  slices?: number;
}

type Box = 'durationSec' | 'intervalSec' | 'sliceQty';

const BOXES: Box[] = ['durationSec', 'intervalSec', 'sliceQty'];

const BOX_OF_FIELD: Record<TwapRefusalView['field'], Box> = {
  duration: 'durationSec',
  interval: 'intervalSec',
  sliceSize: 'sliceQty',
};

const DEFAULT_INPUT: TwapInput = { durationSec: 3_600, intervalSec: 300 };

function parseQty(raw: string): string | null {
  const text = raw.trim();
  return /^\d*\.?\d+$/.test(text) && Number(text) > 0 ? text : null;
}

function isParsed(box: Box, raw: string): boolean {
  return (box === 'sliceQty' ? parseQty(raw) : parseSpan(raw)) !== null;
}

function entryOf(box: Box, input: TwapInput): TwapInput {
  if (box === 'durationSec') return { durationSec: input.durationSec };
  if (box === 'intervalSec') return { intervalSec: input.intervalSec };
  return { sliceQty: input.sliceQty };
}

function typedEntry(box: Box, raw: string): TwapInput | null {
  if (box === 'sliceQty') {
    const qty = parseQty(raw);
    return qty === null ? null : { sliceQty: qty };
  }
  const sec = parseSpan(raw);
  if (sec === null) return null;
  return box === 'durationSec' ? { durationSec: sec } : { intervalSec: sec };
}

function nextInput(input: TwapInput, box: Box, own: TwapInput, recent: Box[], plan: TwapPlanView | null): TwapInput {
  const kept = BOXES.filter((other) => other !== box && input[other] !== undefined).sort(
    (a, b) => recent.indexOf(b) - recent.indexOf(a),
  )[0];
  if (kept) return { ...entryOf(kept, input), ...own };
  if (input.slices !== undefined && box !== 'sliceQty') return { slices: input.slices, ...own };
  if (box === 'durationSec') return { ...own, intervalSec: plan?.intervalSec ?? DEFAULT_INPUT.intervalSec };
  return { ...own, durationSec: plan?.durationSec ?? DEFAULT_INPUT.durationSec };
}

function isComplete(input: TwapInput): boolean {
  const has = (value: unknown): boolean => value !== undefined && value !== null;
  if (has(input.durationSec)) return has(input.slices) || has(input.intervalSec) || has(input.sliceQty);
  if (has(input.intervalSec)) return has(input.sliceQty) || has(input.slices);
  return false;
}

export function useTwapInput(): {
  on: boolean;
  setOn: (on: boolean) => void;
  input: TwapInput;
  setInput: (input: TwapInput) => void;
  startBlocked: boolean;
  blockedBy: (preview: TwapPlanPreview | null | undefined) => boolean;
} {
  const [on, setOn] = useState(false);
  const [input, setInput] = useState<TwapInput>(DEFAULT_INPUT);
  const startBlocked = on && !isComplete(input);
  const blockedBy = (preview: TwapPlanPreview | null | undefined): boolean =>
    on && (startBlocked || !preview?.plan || preview.refusal !== null);
  return { on, setOn, input, setInput, startBlocked, blockedBy };
}

function ImpactPair({ impact }: { impact: PriceImpactPreview }) {
  const { t } = useTranslation();
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-400">
      <HoverCard label={t('trade.twap.area.priceImpact')} widthPx={260}>
        {t('trade.twap.area.priceImpactTitle')}
      </HoverCard>{' '}
      <span className="num text-ink-200">
        {impact.whole === null ? t('trade.twap.area.tooThin') : fmtUsd(impact.whole, 0)}
      </span>{' '}
      <ArrowRight size={12} aria-hidden />{' '}
      <span className="num text-grass">{fmtUsd(impact.sliced, 0)}</span>
    </span>
  );
}

function RefusalLine({ refusal, onFix }: { refusal: TwapRefusalView; onFix: (patch: TwapInput) => void }) {
  const fix = refusal.fix;
  return (
    <p className="text-[11px] text-rose-400">
      <X size={12} aria-hidden className="inline" /> {localizeServerText(refusal.text)}{' '}
      {fix && (
        <button type="button" className="btn-link text-[11px]" onClick={() => onFix(fix.patch)}>
          {localizeServerText(fix.label)}
        </button>
      )}
    </p>
  );
}

export function TwapArea({
  on,
  onToggle,
  input,
  onInput,
  preview,
  impact,
  coin,
  offLabel,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  input: TwapInput;
  onInput: (input: TwapInput) => void;
  preview: TwapPlanPreview | null;
  impact: PriceImpactPreview | null;
  coin: string;
  offLabel?: ReactNode;
}) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Partial<Record<Box, string>>>({});
  const [recent, setRecent] = useState<Box[]>([]);
  const plan = preview?.plan ?? null;
  const refusal = preview?.refusal ?? null;

  const shown = (box: Box): string => {
    const draft = drafts[box];
    if (draft !== undefined) return draft;
    if (box === 'sliceQty') return input.sliceQty ?? plan?.sliceQty ?? '';
    const sec = input[box] ?? plan?.[box];
    return sec === undefined ? '' : spanText(sec);
  };

  const type = (box: Box, raw: string) => {
    setDrafts((current) => ({ ...current, [box]: raw }));
    const own = typedEntry(box, raw);
    if (own === null) return;
    setRecent((current) => [...current.filter((other) => other !== box), box]);
    onInput(nextInput(input, box, own, recent, plan));
  };

  const settle = (box: Box) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[box];
      return next;
    });

  const applyFix = (patch: TwapInput) => {
    setDrafts({});
    setRecent([]);
    if (Object.keys(patch).length === 0) onToggle(false);
    else onInput(patch);
  };

  const isBad = (box: Box): boolean => {
    const draft = drafts[box];
    if (refusal !== null && BOX_OF_FIELD[refusal.field] === box) return true;
    return draft !== undefined && draft.trim() !== '' && !isParsed(box, draft);
  };

  const field = (box: Box, label: string) => {
    const isTyped = input[box] !== undefined;
    const control = (
      <input
        aria-label={label}
        className={`input num ${box === 'sliceQty' ? 'pr-12' : ''} ${isTyped ? 'text-ink-50' : 'text-ink-400'} ${
          isBad(box) ? '!border-rose-500/60' : ''
        }`}
        inputMode={box === 'sliceQty' ? 'decimal' : 'text'}
        data-source={isTyped ? 'typed' : 'app'}
        aria-invalid={isBad(box) || undefined}
        value={shown(box)}
        onChange={(e) => type(box, e.target.value)}
        onBlur={() => settle(box)}
      />
    );
    return (
      <label className="flex min-w-0 flex-col gap-1 text-[11px] text-ink-400">
        {label}
        {box === 'sliceQty' ? <AffixedInput affix={coin}>{control}</AffixedInput> : control}
      </label>
    );
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-ink-700 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <HoverCard icon={false} underline={false} wrapsControl widthPx={260} label={<Switch on={on} onChange={onToggle} label={t('trade.twap.area.title')} />}>
          {t('trade.twap.area.hover')}
        </HoverCard>
        {impact && <ImpactPair impact={impact} />}
      </div>
      {!on && offLabel}
      {on && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {field('durationSec', t('trade.twap.area.duration'))}
            {field('intervalSec', t('trade.twap.area.interval'))}
            {field('sliceQty', t('trade.twap.area.sliceSize'))}
          </div>
          {refusal && <RefusalLine refusal={refusal} onFix={applyFix} />}
          {plan && (
            <span className="num text-[11px] text-ink-300">
              {plan.lastQty === plan.sliceQty
                ? t('trade.twap.area.slicesOnly', { n: plan.slices })
                : t('trade.twap.area.slices', { n: plan.slices, qty: sigGrouped(plan.lastQty), coin })}
            </span>
          )}
        </>
      )}
    </div>
  );
}
