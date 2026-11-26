import { useState, type ReactNode } from 'react';
import { useDeleverPlan, useStartRebalance } from '../api/queries';
import type { DeleverPlan, DeleverRequest, RealizeExec, SliceOption } from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { HoverCard } from '../components/HoverCard';
import { ExecModeToggle } from '../components/ExecModeToggle';
import { PairPicker, type PairPickerRow } from '../components/PairPicker';
import { AmountPresets } from '../components/AmountPresets';
import { Skeleton } from '../components/Skeleton';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { t } from '../i18n';
import { amountError } from '../lib/amount';
import { fmtAbout, fmtDateLocal, fmtUsd, fmtUsdCompact, prettyVenue, sig, sigGrouped, WALLET_SHORT } from '../lib/fmt';
import { apiErrorText } from '../lib/apiErrorText';
import { useNow } from '../lib/useNow';
import { BorosLogInButton } from '../trade/BorosAgentSetup';
import { MakerSettings, REPEG_DEFAULT_BP } from '../trade/MakerSettings';
import { TwapArea, useTwapInput } from '../trade/TwapArea';
import { useTakerAfter, useTwapTakerAfter } from '../trade/useTwapTakerAfter';
import { daysLeftText, useOpenPairs, type OpenPair } from './assets/pairs';
import { RebalanceBeforeAfter, type ChangeRow, type WalletChange } from './RebalanceBeforeAfter';
import { VerdictAlert } from './RebalanceBits';
import { spanText } from '../lib/span';
import { execModeLabel, poolKey } from './rebalanceCopy';
import { SLICE_HOVER } from './RebalanceHovers';
import { RebalanceModalFooter } from './RebalanceModalFooter';
import { parsedAmount } from './rebalanceModalPlan';
import { NotHedgedLine, realizeText, TotalCost, type CostRow } from './RebalancePlanBits';
import { SliceSizeRow } from './SliceTable';
import { useActiveWallet } from './trackedAddress';

type Share = '10' | '20' | '30';
const SHARES: Share[] = ['10', '20', '30'];
type SlicePick = { kind: 'preset'; usd: number } | { kind: 'custom' } | null;

const largestIm = (pairs: OpenPair[]): OpenPair | null =>
  pairs.reduce<OpenPair | null>((best, p) => (best === null || p.imUsd > best.imUsd ? p : best), null);

const qtyText = (qty: number): string => sigGrouped(qty);

const pctText = (pct: number): string => sigGrouped(pct >= 0.1 ? Math.round(pct * 10) / 10 : Math.round(pct * 1000) / 1000);

function rowOf(pair: OpenPair, now: number): PairPickerRow {
  return {
    key: pair.key,
    longVenue: pair.longVenue,
    shortVenue: pair.shortVenue,
    base: pair.base,
    maturityText: t('assetCard.maturesDot', { date: fmtDateLocal(pair.maturitySec), left: daysLeftText(pair.maturitySec, now / 1000) }),
    sizeText: t('accounts.deleverTab.pairSize', { qty: qtyText(pair.size), coin: pair.base }),
    imText: fmtUsdCompact(pair.imUsd),
  };
}

const shareQty = (pair: OpenPair, share: Share): number => (pair.size * Number(share)) / 100;
const shareText = (pair: OpenPair, share: Share): string => sig(shareQty(pair, share));

function litShare(pair: OpenPair, text: string): Share | null {
  const trimmed = text.trim();
  if (trimmed === '' || amountError(trimmed) !== null) return null;
  return SHARES.find((share) => Number(shareText(pair, share)) === Number(trimmed)) ?? null;
}

function closeOf(pair: OpenPair, raw: string): { close: number | null; error: string | null } {
  const lit = litShare(pair, raw);
  if (lit !== null) return { close: shareQty(pair, lit), error: null };
  const text = raw.trim();
  if (text === '') return { close: null, error: t('app.amount.notPositive') };
  const error = amountError(text);
  if (error !== null) return { close: null, error };
  const close = Number(text);
  if (close > pair.size) return { close: null, error: t('app.amount.max', { value: qtyText(pair.size) }) };
  return { close, error: null };
}

type MakerOpts = { takerAfterSec?: number | null; repegBehindBp?: number | null };
type BorosGas = { borosCloses?: number; borosGasUsd?: number | null };

function requestOf(
  pair: OpenPair,
  close: number,
  exec: RealizeExec,
  sliceUsd: number | null,
  twap: (DeleverRequest['twap'] & MakerOpts) | undefined,
): DeleverRequest {
  return {
    perps: pair.perps.map((p) => ({ symbol: p.symbol, qty: close })),
    boros: pair.boros.map((b) => ({ marketId: b.marketId, size: (b.size * close) / pair.size })),
    exec,
    ...(sliceUsd !== null ? { sliceUsd } : {}),
    ...(twap ? { twap } : {}),
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
    hover: SLICE_HOVER.imUsed,
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
  const wallet = useActiveWallet();
  const { pairs: open, loading, failed, retry } = useOpenPairs();
  const [picked, setPicked] = useState<string | null>(pairKey);
  const [typed, setTyped] = useState<string | null>(null);
  const [exec, setExec] = useState<RealizeExec>('maker');
  const [slicePick, setSlicePick] = useState<SlicePick>(null);
  const [sliceText, setSliceText] = useState('');
  const [slicesOpen, setSlicesOpen] = useState(false);
  const pairs = open.filter((p) => p.unit === 'base');
  const pair = pairs.find((p) => p.key === picked) ?? largestIm(pairs);
  const amountText = typed ?? (pair ? shareText(pair, '20') : '');
  const { close, error: amountProblem } = pair ? closeOf(pair, amountText) : { close: null, error: null };
  const twap = useTwapInput();
  const sliceUsd = sliceUsdOf(slicePick, sliceText);
  const taker = useTakerAfter();
  const [repegBp, setRepegBp] = useState<number | null>(REPEG_DEFAULT_BP);
  const makerOpts: MakerOpts = {
    takerAfterSec: taker.sec,
    repegBehindBp: repegBp,
  };
  const twapSent = twap.on && !twap.startBlocked ? { ...twap.input, ...(exec === 'maker' ? makerOpts : {}) } : undefined;
  const request = pair !== null && close !== null ? requestOf(pair, close, exec, twap.on ? null : sliceUsd, twapSent) : null;
  const query = useDeleverPlan(request);
  const takerBad = useTwapTakerAfter(taker, twap.on, query.data?.twap?.plan?.takerAfterSec ?? null);

  if (loading) return <Skeleton className="h-40 w-full" />;
  if (failed) {
    return (
      <EmptyState
        title={t('accounts.deleverTab.pairsFailed')}
        action={
          <button type="button" className="btn" onClick={retry}>
            {t('common.retry')}
          </button>
        }
      />
    );
  }
  if (pair === null) return <EmptyState title={t('accounts.deleverTab.noPairs')} />;

  const plan = request !== null ? (query.data ?? null) : null;
  const pct = close === null ? 0 : (close / pair.size) * 100;
  const option = plan ? optionOf(plan, slicePick) : null;
  const estimate = plan?.estimates[exec] ?? null;
  const borosGapYu = plan ? plan.boros.reduce((sum, b) => sum + b.closeSize, 0) : 0;
  const leadClose = plan?.legs[plan.makerLeg]?.closeQty ?? 0;
  const needsBoros = pair.boros.length > 0;
  const walletBlocked = needsBoros && wallet.state !== null && !wallet.canTrade;
  const walletReady = !needsBoros || wallet.canTrade;
  const stale = plan !== null && query.isError;
  const twapPlan = twap.on ? (plan?.twap?.plan ?? null) : null;
  const twapBody = twapPlan
    ? { durationSec: twapPlan.durationSec, slices: twapPlan.slices, ...(exec === 'maker' ? makerOpts : {}) }
    : undefined;
  const gas = (plan ?? {}) as BorosGas;
  const gasRow =
    twapPlan && (gas.borosCloses ?? 0) > 0 && (gas.borosGasUsd ?? 0) > 0
      ? [{ label: t('accounts.delever.borosGas', { n: gas.borosCloses }), usd: gas.borosGasUsd as number }]
      : [];
  const slicePastBook = !twap.on && option?.pastBook === true;
  const twapBlocked = twap.blockedBy(plan?.twap);
  const ready =
    plan !== null &&
    !query.isPlaceholderData &&
    !stale &&
    plan.refused === null &&
    !slicePastBook &&
    !twapBlocked &&
    !takerBad &&
    lock === null &&
    !start.isPending &&
    walletReady;

  const modeLabel = (mode: RealizeExec): string =>
    execModeLabel(mode, fmtUsd(plan?.estimates[mode].totalUsd ?? 0, 0), fmtAbout(option ? option.seconds[mode] / Math.max(1, option.count) : 0));

  const costRows: CostRow[] = estimate
    ? [
        { label: t('accounts.deleverTab.tradingFeePerps'), usd: estimate.feePerpsUsd, hover: SLICE_HOVER.tradingFeePerps },
        ...(plan && plan.boros.length > 0 ? [{ label: t('accounts.deleverTab.tradingFeeBoros'), usd: estimate.feeBorosUsd }] : []),
        ...gasRow,
        { label: t('accounts.deleverTab.priceImpact'), usd: estimate.impactUsd, hover: SLICE_HOVER.priceImpact },
        { label: t('accounts.deleverTab.totalCost'), usd: estimate.totalUsd, strong: true },
      ]
    : [];

  const typedQty = Number(amountText.trim());
  const holdQty = close ?? (Number.isFinite(typedQty) ? typedQty : 0);
  const holdLabel =
    twapPlan
      ? t('accounts.delever.holdTwap', { coin: pair.base, qty: qtyText(holdQty), duration: spanText(twapPlan.durationSec) })
      : t('accounts.deleverTab.hold', { coin: pair.base, qty: qtyText(holdQty) });

  const confirm = () => {
    if (request === null || estimate === null || close === null) return;
    const delever = twapBody ? requestOf(pair, close, exec, null, twapBody) : request;
    start.mutate(
      { kind: 'delever', exec, sliceUsd: twapBody ? undefined : (option?.sizeUsd ?? sliceUsd ?? undefined), delever, costUsd: estimate.totalUsd },
      { onSuccess: onStarted, onError: (error) => toast.push('error', apiErrorText(error)) },
    );
  };

  const shareOptions: { value: Share; label: string }[] = [
    { value: '10', label: t('accounts.deleverTab.pct10') },
    { value: '20', label: t('accounts.deleverTab.pct20') },
    { value: '30', label: t('accounts.deleverTab.pct30') },
  ];

  const planBody = (): ReactNode => {
    if (request === null) {
      return (
        <RebalanceModalFooter
          rows={[]}
          holdLabel={holdLabel}
          optional={false}
          stale={false}
          quoteStale={false}
          lock={lock}
          pricing={false}
          disabled
          holdMs={holdMs}
          onRefresh={() => undefined}
          onConfirm={() => undefined}
        />
      );
    }
    if (query.isError && plan === null) return <VerdictAlert tone="warn" text={query.error.message} />;
    if (plan === null) return <Skeleton className="h-48 w-full" />;
    const hedgeGapQty = twapPlan ? Number(twapPlan.sliceQty) : plan.notHedgedMaxQty;
    const hedgeGapUsd = twapPlan ? (plan.notHedgedMaxUsd / plan.notHedgedMaxQty) * hedgeGapQty : plan.notHedgedMaxUsd;
    const costBox = costRows.length > 0 && !twapBlocked && !plan.refused && !slicePastBook ? <TotalCost rows={costRows} /> : null;
    const venue = plan.refused?.reason === 'below-min' ? prettyVenue(plan.refused.venue) : '';
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
        <TwapArea
          on={twap.on}
          onToggle={twap.setOn}
          input={twap.input}
          onInput={twap.setInput}
          preview={plan.twap ?? null}
          impact={twapBlocked ? null : (plan.priceImpact ?? null)}
          coin={pair.base}
          offLabel={
            option && (
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
            )
          }
        />
        {twap.on && exec === 'maker' && (
          <MakerSettings
            legs={null}
            makerLeg="auto"
            autoPick={null}
            onMakerLeg={() => undefined}
            takerAfter={taker.takerAfter}
            onTakerAfter={taker.pick}
            takerCapSec={twapPlan?.takerAfterSec ?? null}
            repegBehindBp={repegBp}
            repegLocked={false}
            onRepeg={setRepegBp}
          />
        )}
        {twapPlan && borosGapYu > 0 && leadClose > 0 && (
          <div className="flex items-center justify-between gap-3 px-1 text-xs text-ink-300">
            <HoverCard label={t('accounts.delever.borosPerSlice')} widthPx={260}>
              {t('accounts.delever.borosPerSliceHover')}
            </HoverCard>
            <span className="num text-ink-100">
              {t('accounts.delever.borosPerSliceValue', { amount: qtyText((borosGapYu * Number(twapPlan.sliceQty)) / leadClose) })}
            </span>
          </div>
        )}
        <RebalanceBeforeAfter rows={afterChanges(plan, pair)} mode="after" />
        {plan.notHedgedMaxQty > 0 && (
          <NotHedgedLine
            text={t('accounts.deleverTab.notHedged', { qty: qtyText(hedgeGapQty), coin: pair.base, usd: fmtUsd(hedgeGapUsd, 0) })}
          />
        )}
        {borosGapYu > 0 && (
          <VerdictAlert
            tone="warn"
            text={t('accounts.deleverTab.borosGap', { amount: qtyText(borosGapYu), time: fmtAbout(option?.seconds[exec] ?? 0) })}
          />
        )}
        {costBox}
        {walletBlocked && !wallet.loginLabel && (
          <p className="text-xs text-gold">{t('pairTicket.closeBoros.agentReason')}</p>
        )}
        {plan.refused ? (
          <VerdictAlert
            tone="warn"
            text={
              plan.refused.reason === 'same-side'
                ? t('accounts.deleverTab.sameSide')
                : t('accounts.deleverTab.belowMin', { venue, min: qtyText(plan.refused.minQty), coin: plan.refused.coin })
            }
          />
        ) : slicePastBook ? (
          <VerdictAlert tone="warn" text={realizeText('bookTitle')} sub={realizeText('sliceBookBody')} />
        ) : walletBlocked && wallet.loginLabel ? (
          <BorosLogInButton />
        ) : (
          <RebalanceModalFooter
            rows={[]}
            holdLabel={holdLabel}
            optional={false}
            stale={false}
            quoteStale={stale}
            lock={lock}
            pricing={query.isPlaceholderData}
            disabled={!ready}
            holdMs={holdMs}
            onRefresh={() => void query.refetch()}
            onConfirm={confirm}
          />
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
            const next = pairs.find((p) => p.key === key);
            const lit = litShare(pair, amountText);
            setPicked(key);
            setTyped(next && lit ? shareText(next, lit) : '');
          }}
          label={t('accounts.deleverTab.pair')}
          searchLabel={t('accounts.deleverTab.search')}
          columns={{ pair: t('accounts.deleverTab.pair'), size: t('accounts.deleverTab.size'), im: t('accounts.deleverTab.initialMargin') }}
          emptyText={t('accounts.deleverTab.noPairsMatch')}
        />
      </Field>
      <Field label={t('accounts.deleverTab.reduceBy')}>
        <AmountPresets<Share>
          value={amountText}
          onChange={setTyped}
          inputLabel={t('accounts.deleverTab.amountAria')}
          suffix={close !== null ? t('accounts.deleverTab.sizeSuffix', { coin: pair.base, pct: pctText(pct) }) : pair.base}
          bad={amountProblem !== null && amountText.trim() !== ''}
          boxClassName="w-60"
          presetsLabel={t('accounts.deleverTab.reduceBy')}
          preset={litShare(pair, amountText)}
          onPreset={(share) => setTyped(shareText(pair, share))}
          presets={shareOptions}
        />
        {amountProblem !== null && amountText.trim() !== '' && <p className="num text-xs text-guava">{amountProblem}</p>}
      </Field>
      {planBody()}
    </div>
  );
}
