import { useState, type ReactNode } from 'react';
import { useDeleverPlan, useStartRebalance } from '../api/queries';
import type { DeleverPlan, DeleverRequest, RealizeExec, SliceOption } from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { ExecModeToggle } from '../components/ExecModeToggle';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { PairPicker, type PairPickerRow } from '../components/PairPicker';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { Skeleton } from '../components/Skeleton';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { t } from '../i18n';
import { fmtAbout, fmtDateShort, fmtUsd, fmtUsdCompact, prettyVenue, sigGrouped, WALLET_SHORT } from '../lib/fmt';
import { apiErrorText } from '../lib/apiErrorText';
import { daysToMaturity } from '../lib/boros';
import { useNow } from '../lib/useNow';
import { AffixedInput } from '../trade/PairTicketBits';
import { useOpenPairs, type OpenPair } from './assets/pairs';
import { RebalanceBeforeAfter, type ChangeRow, type WalletChange } from './RebalanceBeforeAfter';
import { VerdictAlert } from './RebalanceBits';
import { execModeLabel, poolKey } from './rebalanceCopy';
import { parsedAmount } from './rebalanceModalPlan';
import { TotalCost, type CostRow } from './RebalancePlanBits';
import { SliceSizeRow } from './SliceTable';

type Share = '10' | '20' | '30' | 'custom';
type SlicePick = { kind: 'preset'; usd: number } | { kind: 'custom' } | null;

const largestIm = (pairs: OpenPair[]): OpenPair | null =>
  pairs.reduce<OpenPair | null>((best, p) => (best === null || p.imUsd > best.imUsd ? p : best), null);

const qtyText = (qty: number): string => sigGrouped(qty);

const pctText = (pct: number): string => sigGrouped(pct >= 0.1 ? Math.round(pct * 10) / 10 : Math.round(pct * 1000) / 1000);

function rowOf(pair: OpenPair, now: number): PairPickerRow {
  const days = daysToMaturity(pair.maturitySec, now / 1000);
  return {
    key: pair.key,
    longVenue: pair.longVenue,
    shortVenue: pair.shortVenue,
    base: pair.base,
    maturityText: t('accounts.deleverTab.matures', { date: fmtDateShort(pair.maturitySec, { year: 'numeric' }), count: days }),
    sizeText: t('accounts.deleverTab.pairSize', { qty: qtyText(pair.size), coin: pair.base }),
    imText: fmtUsdCompact(pair.imUsd),
  };
}

function closeOf(pair: OpenPair, share: Share, customText: string): number | null {
  if (share !== 'custom') return (pair.size * Number(share)) / 100;
  return parsedAmount(customText);
}

function requestOf(pair: OpenPair, close: number, exec: RealizeExec, sliceUsd: number | null): DeleverRequest {
  return {
    perps: pair.perps.map((p) => ({ symbol: p.symbol, qty: close })),
    boros: pair.boros.map((b) => ({ marketId: b.marketId, size: (b.size * close) / pair.size })),
    exec,
    ...(sliceUsd !== null ? { sliceUsd } : {}),
  };
}

function sliceUsdOf(pick: SlicePick, customText: string): number | null {
  if (pick === null) return null;
  return pick.kind === 'preset' ? pick.usd : parsedAmount(customText);
}

function optionOf(plan: DeleverPlan, pick: SlicePick): SliceOption | null {
  const options = plan.sliceOptions;
  const preset = (usd: number) => options.find((o) => !o.custom && o.sizeUsd === usd) ?? null;
  if (pick?.kind === 'custom') return options.find((o) => o.custom) ?? preset(plan.defaultSliceUsd);
  return preset(pick === null ? plan.defaultSliceUsd : pick.usd) ?? preset(plan.defaultSliceUsd);
}

const qtyRow = (label: string, before: number, after: number, suffix: string): ChangeRow => ({
  label,
  before,
  after,
  unit: 'text',
  text: { before: qtyText(before), after: qtyText(after) },
  suffix,
});

function afterChanges(plan: DeleverPlan, pair: OpenPair): WalletChange[] {
  const lead = plan.legs[0];
  const perpsLabel = t('accounts.deleverTab.perpsLabel', { longVenue: prettyVenue(pair.longVenue), shortVenue: prettyVenue(pair.shortVenue) });
  const perps = lead ? [qtyRow(perpsLabel, lead.before, lead.after, t('accounts.deleverTab.coinEach', { coin: pair.base }))] : [];
  const boros = plan.boros.map((b) => qtyRow(t('accounts.deleverTab.borosLabel'), Math.abs(b.before), Math.abs(b.after), t('accounts.deleverTab.yu')));
  const im = plan.imUsed.map((row): ChangeRow => ({
    label: t('accounts.deleverTab.imUsedLabel', { account: WALLET_SHORT[poolKey(row.account)] ?? row.account }),
    before: row.before,
    after: row.after,
    unit: 'pct',
  }));
  return [{ key: pair.key, label: pair.base, rows: [...perps, ...boros, ...im] }];
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={microLabelClass}>{label}</span>
      {children}
    </div>
  );
}

export function DeleverTab({ pairKey, holdMs, lock, onStarted }: { pairKey: string | null; holdMs?: number; lock: string | null; onStarted: () => void }) {
  const now = useNow(60_000);
  const toast = useToast();
  const start = useStartRebalance();
  const { pairs: open, loading } = useOpenPairs();
  const [picked, setPicked] = useState<string | null>(pairKey);
  const [share, setShare] = useState<Share>('20');
  const [customText, setCustomText] = useState('');
  const [exec, setExec] = useState<RealizeExec>('maker');
  const [slicePick, setSlicePick] = useState<SlicePick>(null);
  const [sliceText, setSliceText] = useState('');
  const [slicesOpen, setSlicesOpen] = useState(false);
  const pairs = open.filter((p) => p.unit === 'base');
  const pair = pairs.find((p) => p.key === picked) ?? largestIm(pairs);
  const close = pair ? closeOf(pair, share, customText) : null;
  const valid = pair !== null && close !== null && close > 0 && close <= pair.size;
  const sliceUsd = sliceUsdOf(slicePick, sliceText);
  const request = valid ? requestOf(pair, close, exec, sliceUsd) : null;
  const query = useDeleverPlan(request);

  if (loading) return <Skeleton className="h-40 w-full" />;
  if (pair === null) return <EmptyState title={t('accounts.deleverTab.noPairs')} />;

  const plan = request !== null ? (query.data ?? null) : null;
  const pct = close === null ? 0 : (close / pair.size) * 100;
  const option = plan ? optionOf(plan, slicePick) : null;
  const estimate = plan?.estimates[exec] ?? null;
  const borosGapYu = plan ? plan.boros.reduce((sum, b) => sum + b.closeSize, 0) : 0;
  const ready = plan !== null && !query.isPlaceholderData && plan.refused === null && lock === null && !start.isPending;

  const modeLabel = (mode: RealizeExec): string =>
    execModeLabel(mode, fmtUsd(plan?.estimates[mode].totalUsd ?? 0, 0), fmtAbout(option?.seconds[mode] ?? 0));

  const costRows: CostRow[] = estimate
    ? [
        { label: t('accounts.deleverTab.tradingFeePerps'), usd: estimate.feePerpsUsd },
        ...(plan && plan.boros.length > 0 ? [{ label: t('accounts.deleverTab.tradingFeeBoros'), usd: estimate.feeBorosUsd }] : []),
        { label: t('accounts.deleverTab.priceImpact'), usd: estimate.impactUsd },
        { label: t('accounts.deleverTab.totalCost'), usd: estimate.totalUsd, strong: true },
      ]
    : [];

  const confirm = () => {
    if (request === null || estimate === null) return;
    start.mutate(
      { kind: 'delever', exec, sliceUsd: option?.sizeUsd ?? sliceUsd ?? undefined, delever: request, costUsd: estimate.totalUsd },
      { onSuccess: onStarted, onError: (error) => toast.push('error', apiErrorText(error)) },
    );
  };

  const shareOptions: { value: Share; label: string }[] = [
    { value: '10', label: t('accounts.deleverTab.pct10') },
    { value: '20', label: t('accounts.deleverTab.pct20') },
    { value: '30', label: t('accounts.deleverTab.pct30') },
    { value: 'custom', label: t('accounts.deleverTab.custom') },
  ];

  const planBody = (): ReactNode => {
    if (request === null) return null;
    if (query.isError && !query.isPlaceholderData) return <VerdictAlert tone="warn" text={query.error.message} />;
    if (plan === null) return <Skeleton className="h-48 w-full" />;
    const venue = plan.refused ? prettyVenue(plan.refused.venue) : '';
    return (
      <>
        <Field label={t('accounts.realizeTab.orders')}>
          <ExecModeToggle
            ariaLabel={t('accounts.realizeTab.orders')}
            fill
            value={exec}
            onChange={setExec}
            order={['maker', 'market']}
            labels={{ maker: modeLabel('maker'), market: modeLabel('market') }}
          />
        </Field>
        {option && (
          <SliceSizeRow
            sizeUsd={option.sizeUsd}
            count={option.count}
            open={slicesOpen}
            onToggle={() => setSlicesOpen((v) => !v)}
            table={{
              options: plan.sliceOptions,
              value: slicePick?.kind === 'custom' ? (plan.sliceOptions.find((o) => o.custom)?.sizeUsd ?? -1) : option.sizeUsd,
              exec,
              onPick: (usd) => setSlicePick(plan.sliceOptions.some((o) => !o.custom && o.sizeUsd === usd) ? { kind: 'preset', usd } : { kind: 'custom' }),
              customText: sliceText,
              onCustom: (text) => {
                setSliceText(text);
                setSlicePick({ kind: 'custom' });
              },
              coin: pair.base,
            }}
          />
        )}
        {costRows.length > 0 && <TotalCost rows={costRows} />}
        <RebalanceBeforeAfter rows={afterChanges(plan, pair)} mode="after" />
        {plan.notHedgedMaxQty > 0 && (
          <VerdictAlert
            tone="warn"
            text={t('accounts.deleverTab.notHedged', { qty: qtyText(plan.notHedgedMaxQty), coin: pair.base, usd: fmtUsd(plan.notHedgedMaxUsd, 0) })}
          />
        )}
        {borosGapYu > 0 && (
          <VerdictAlert
            tone="warn"
            text={t('accounts.deleverTab.borosGap', { amount: qtyText(borosGapYu), time: fmtAbout(option?.seconds[exec] ?? 0) })}
          />
        )}
        {plan.refused ? (
          <VerdictAlert
            tone="warn"
            text={t('accounts.deleverTab.belowMin', { venue, min: qtyText(plan.refused.minQty), coin: plan.refused.coin })}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <HoldToConfirmButton holdMs={holdMs} disabled={!ready} onConfirm={confirm}>
              {t('accounts.deleverTab.hold', {
                coin: pair.base,
                venueA: prettyVenue(pair.longVenue),
                venueB: prettyVenue(pair.shortVenue),
                pct: pctText(pct),
                qty: qtyText(close ?? 0),
              })}
            </HoldToConfirmButton>
            {lock !== null && <span className="text-xs text-ink-500">{lock}</span>}
            {lock === null && query.isPlaceholderData && <span className="text-xs text-ink-500">{t('accounts.rebalanceModal.pricing')}</span>}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('accounts.deleverTab.pair')}>
        <PairPicker
          rows={pairs.map((p) => rowOf(p, now))}
          value={pair.key}
          onChange={(key) => {
            setPicked(key);
            setCustomText('');
          }}
          label={t('accounts.deleverTab.pair')}
          searchLabel={t('accounts.deleverTab.search')}
          columns={{ pair: t('accounts.deleverTab.pair'), size: t('accounts.deleverTab.size'), im: t('accounts.deleverTab.initialMargin') }}
          emptyText={t('accounts.deleverTab.noPairsMatch')}
        />
      </Field>
      <Field label={t('accounts.deleverTab.reduceBy')}>
        <SegmentedToggle<Share> ariaLabel={t('accounts.deleverTab.reduceBy')} fill value={share} onChange={setShare} options={shareOptions} />
        {share === 'custom' && (
          <div className="flex items-center gap-3">
            <div className="w-48">
              <AffixedInput affix={pair.base}>
                <input
                  className="input num h-8 w-full pr-12"
                  inputMode="decimal"
                  aria-label={t('accounts.deleverTab.custom')}
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                />
              </AffixedInput>
            </div>
            {close !== null && close > 0 && <span className="num text-xs text-ink-100">{t('accounts.deleverTab.customPct', { pct: pctText(pct) })}</span>}
          </div>
        )}
      </Field>
      {planBody()}
    </div>
  );
}
