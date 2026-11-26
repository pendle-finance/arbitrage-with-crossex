import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRealizeCustom, useStartRebalance } from '../api/queries';
import type { Pool, RealizeExec, RealizePlan, RealizeTab as RealizeTabData, RebalanceView } from '../api/types';
import { AmountPresets } from '../components/AmountPresets';
import { EmptyState } from '../components/EmptyState';
import { ExecModeToggle } from '../components/ExecModeToggle';
import { Skeleton } from '../components/Skeleton';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { apiErrorText } from '../lib/apiErrorText';
import { fmtAbout, fmtUsd, num } from '../lib/fmt';
import { useDebounced } from '../lib/useDebounced';
import { borrowRows, RebalanceBeforeAfter, type WalletChange } from './RebalanceBeforeAfter';
import { VerdictAlert } from './RebalanceBits';
import { keyOf, SLICE_HOVER, Term } from './RebalanceHovers';
import { RebalanceModalFooter } from './RebalanceModalFooter';
import { NotHedgedLine, realizeText, refusalOf, TotalCost, type CostRow } from './RebalancePlanBits';
import { CONVERT_TO, execModeLabel, HOVER, hoverCash, poolCoin, poolKey, sizeText, WALLET_LABEL } from './rebalanceCopy';
import { CUSTOM_DEBOUNCE_MS, parsedAmount } from './rebalanceModalPlan';
import type { RebalanceTab } from './rebalanceOpener';
import { costOf, hasPlan, netOf, sliceOf, type Cost, type Slice } from './realizeTabCost';
import { SliceSizeRow } from './SliceTable';

type AmountPick = 'clear' | 'all' | 'custom';

const TARGET: Record<AmountPick, 'clear-debt' | 'all' | 'custom'> = { clear: 'clear-debt', all: 'all', custom: 'custom' };

const EXEC_ORDER: RealizeExec[] = ['maker', 'market'];

type TabProps = {
  view: RebalanceView;
  holdMs?: number;
  lock: string | null;
  onTab: (tab: RebalanceTab) => void;
  onStarted: () => void;
};

export function RealizeTab(props: TabProps) {
  const base = props.view.realize ?? null;
  const [picked, setPicked] = useState<Pool | null>(null);
  const pool = base && picked !== null && base.pools.includes(picked) ? picked : (base?.pool ?? null);
  const other = base !== null && pool !== null && pool !== base.pool;
  const poolQuery = useRealizeCustom(null, null, other ? pool : null);
  const loaded = other ? (poolQuery.data?.realize ?? null) : null;
  const lost = other && loaded !== null && !loaded.pools.includes(pool);
  useEffect(() => {
    if (lost) setPicked(null);
  }, [lost]);
  const tab = other ? (loaded?.pool === pool ? loaded : null) : base;
  return (
    <>
      {base && pool && <RealizeWallet view={props.view} pools={base.pools} pool={pool} onPick={setPicked} />}
      {other && !tab ? <Skeleton className="h-40 w-full" /> : <RealizeBody key={pool ?? ''} {...props} tab={tab} />}
    </>
  );
}

function RealizeWallet({ view, pools, pool, onPick }: { view: RebalanceView; pools: Pool[]; pool: Pool; onPick: (pool: Pool) => void }) {
  const { t } = useTranslation();
  const walletOf = (p: Pool): string => WALLET_LABEL[poolKey(p)] ?? poolKey(p);
  const upnlOf = (p: Pool): number => view.buckets.find((b) => keyOf(b) === poolKey(p))?.upnl ?? 0;
  if (pools.length < 2) {
    return (
      <div className="flex items-center gap-3 text-xs">
        <span className="text-ink-400">{t('accounts.realizeTab.wallet', { wallet: walletOf(pool) })}</span>
        <span className="num text-ink-100">{t('accounts.realizeTab.walletUpnl', { amount: num(upnlOf(pool), 0), coin: poolCoin(pool) })}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className={microLabelClass}>{t('accounts.realizeTab.walletLabel')}</span>
      <select
        aria-label={t('accounts.realizeTab.walletLabel')}
        className="input num h-8 !py-0 text-xs"
        value={pool}
        onChange={(e) => onPick(e.target.value as Pool)}
      >
        {pools.map((p) => (
          <option key={p} value={p}>
            {t('accounts.realizeTab.walletOption', { wallet: walletOf(p), amount: num(upnlOf(p), 0), coin: poolCoin(p) })}
          </option>
        ))}
      </select>
    </div>
  );
}

function RealizeBody({ view, tab, holdMs, lock, onTab, onStarted }: TabProps & { tab: RealizeTabData | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const start = useStartRebalance();
  const clearDebt = hasPlan(tab?.clearDebt ?? null) ? (tab?.clearDebt ?? null) : null;
  const all = hasPlan(tab?.all ?? null) ? (tab?.all ?? null) : null;
  const [amount, setAmount] = useState<AmountPick>(() => (clearDebt ? 'clear' : 'all'));
  const [exec, setExec] = useState<RealizeExec>('maker');
  const [sliceUsd, setSliceUsd] = useState(() => tab?.defaultSliceUsd ?? 0);
  const [sliceText, setSliceText] = useState('');
  const [tableOpen, setTableOpen] = useState(false);
  const [customText, setCustomText] = useState('');

  const presetOptions = tab?.sliceOptions ?? [];
  const basePriced = clearDebt && clearDebt.legs.length > 0 ? clearDebt : all;
  const customSlice = sliceUsd > 0 && !presetOptions.some((o) => !o.custom && o.sizeUsd === sliceUsd);
  const sliceQueried = sliceUsd > 0 && sliceUsd !== tab?.defaultSliceUsd;
  const debouncedSlice = useDebounced(sliceUsd, CUSTOM_DEBOUNCE_MS);
  const baseAllNet = all ? Math.max(0, netOf(all, costOf(all, exec, sliceOf(presetOptions, sliceUsd, all.legs[0], all === basePriced)))) : 0;
  const typedUsd = parsedAmount(customText.replaceAll(',', ''));
  const customUsd = typedUsd !== null && typedUsd > 0 ? Math.min(typedUsd, baseAllNet) : null;
  const debouncedUsd = useDebounced(customUsd, CUSTOM_DEBOUNCE_MS);
  const queried = (amount === 'custom' && debouncedUsd !== null) || sliceQueried;
  const customQuery = useRealizeCustom(amount === 'custom' ? debouncedUsd : null, sliceQueried ? debouncedSlice : null, queried && tab ? tab.pool : null);
  const customPlan = customQuery.data?.realize?.custom ?? null;
  const liveTab = sliceQueried ? (customQuery.data?.realize ?? null) : null;
  const shownClear = liveTab ? (hasPlan(liveTab.clearDebt) ? liveTab.clearDebt : null) : clearDebt;
  const shownAll = liveTab ? (hasPlan(liveTab.all) ? liveTab.all : null) : all;
  const pricedPlan = shownClear && shownClear.legs.length > 0 ? shownClear : shownAll;
  const options = liveTab?.sliceOptions ?? presetOptions;
  const customOption = customSlice ? (liveTab?.sliceOptions.find((o) => o.custom) ?? null) : null;
  const shownSliceUsd = customOption?.sizeUsd ?? sliceUsd;
  const sliceFor = (plan: RealizePlan): Slice | null => sliceOf(options, shownSliceUsd, plan.legs[0], plan === pricedPlan);
  const costFor = (plan: RealizePlan, mode: RealizeExec): Cost => costOf(plan, mode, sliceFor(plan));
  const allNet = shownAll ? Math.max(0, netOf(shownAll, costFor(shownAll, exec))) : 0;

  if (!tab || (!clearDebt && !all)) {
    return (
      <EmptyState
        title={t('accounts.realizeTab.noUpnl')}
        action={
          <button type="button" className="btn" onClick={() => onTab('move')}>
            {t('accounts.rebalanceTabs.move')}
          </button>
        }
      />
    );
  }

  const sliceInvalid = sliceText.trim() !== '' && !((parsedAmount(sliceText) ?? 0) > 0);
  const customMissing = amount === 'custom' && customUsd === null;
  const customOverAll = amount === 'custom' && typedUsd !== null && customUsd !== null && typedUsd > customUsd;
  const active = amount === 'clear' ? shownClear : amount === 'all' ? shownAll : customMissing ? null : customPlan;
  const slicePricing = sliceQueried && (debouncedSlice !== sliceUsd || customQuery.isFetching);
  const pricing = slicePricing || (amount === 'custom' && customUsd !== null && (customUsd !== debouncedUsd || customQuery.isFetching));
  const slice = active ? sliceFor(active) : null;
  const cost = active ? costFor(active, exec) : null;
  const net = active && cost ? netOf(active, cost) : 0;
  const lead = active?.legs[0];
  const slicePastBook = options.find((o) => o.sizeUsd === shownSliceUsd)?.pastBook === true;
  const refusal = active?.refused
    ? refusalOf({ ...view.plans.repay, realize: active })
    : active && slicePastBook
      ? { title: realizeText('bookTitle'), body: realizeText('sliceBookBody') }
      : null;
  const sliceRefused = slicePastBook || (sliceQueried && active?.refused?.reason === 'past-book');
  const wallet = WALLET_LABEL[poolKey(tab.pool)] ?? poolKey(tab.pool);
  const bucket = view.buckets.find((b) => keyOf(b) === poolKey(tab.pool));
  const cashNow = bucket?.cash ?? 0;
  const clearNet = shownClear ? netOf(shownClear, costFor(shownClear, exec)) : 0;
  const debtNet = clearDebt ? Math.max(0, clearNet) : 0;
  const boxText = amount === 'clear' ? num(debtNet, 0) : amount === 'all' ? num(allNet, 0) : customText;

  const execLabel = (mode: RealizeExec): string =>
    execModeLabel(mode, active ? fmtUsd(costFor(active, mode).totalUsd, 0) : '—', slice ? fmtAbout(slice.seconds[mode] / Math.max(1, slice.count)) : '—');

  const rows: CostRow[] = cost
    ? [
        { label: t('accounts.realizeTab.tradingFee'), usd: cost.feeUsd },
        ...(cost.convertUsd > 0 ? [{ label: t('accounts.moveCash.convertFee'), usd: cost.convertUsd }] : []),
        { label: t('accounts.realizeTab.priceImpact'), usd: cost.impactUsd, hover: SLICE_HOVER.priceImpact },
        { label: t('accounts.realizeTab.totalCost'), usd: cost.totalUsd, strong: true },
      ]
    : [];

  const converts = amount === 'all' && active ? active.legs.flatMap((leg) => (leg.convert ? [leg.convert] : [])) : [];
  const landed = converts.reduce((total, c) => total + c.amount - c.feeUsd, 0);
  const targetKey = poolKey(CONVERT_TO[tab.pool]);
  const target = landed > 0 ? view.buckets.find((b) => keyOf(b) === targetKey && b.borrow > 0) : undefined;
  const after: WalletChange[] = active
    ? [
        {
          key: poolKey(tab.pool),
          label: wallet,
          rows: [
            { label: t('accounts.realizeTab.realizedAfterCost'), before: null, after: net, unit: 'coin' },
            { label: hoverCash(), before: cashNow, after: cashNow + net - landed, unit: 'coin' },
            { label: t('accounts.sliceRun.pairPnl'), before: 0, after: 0, unit: 'text', text: { before: '', after: t('accounts.sliceRun.pairPnlValue') } },
          ],
        },
        ...(target ? [{ key: targetKey, label: WALLET_LABEL[targetKey] ?? targetKey, rows: borrowRows(target, Math.max(0, target.borrow - landed), null) }] : []),
      ]
    : [];

  const pickSlice = (sizeUsd: number) => setSliceUsd(sizeUsd);
  const typeSlice = (text: string) => {
    setSliceText(text);
    const parsed = parsedAmount(text);
    if (parsed !== null && parsed > 0) setSliceUsd(parsed);
  };

  const confirm = () => {
    if (!active || !cost) return;
    start.mutate(
      {
        kind: 'realize',
        exec,
        sliceUsd: shownSliceUsd,
        realizeUsd: net,
        realizeTarget: TARGET[amount],
        realizePool: tab.pool,
        costUsd: cost.totalUsd,
      },
      { onSuccess: onStarted, onError: (error) => toast.push('error', apiErrorText(error)) },
    );
  };

  const warning = slice && lead ? t('accounts.realizeTab.notHedged', { qty: sizeText(slice.qty), coin: lead.base, usd: fmtUsd(slice.usd, 0) }) : null;
  const sentence: string | null = customMissing
    ? t('accounts.realizeTab.typeAmount')
    : sliceInvalid
      ? t('accounts.realizeTab.typeSlice')
      : customOverAll
        ? t('accounts.realizeTab.customOverAll', { amount: num(allNet, 0), coin: poolCoin(tab.pool) })
        : null;

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className={microLabelClass}>{t('accounts.realizeTab.amount')}</span>
        <AmountPresets<Exclude<AmountPick, 'custom'>>
          value={boxText}
          onChange={(text) => {
            setCustomText(text);
            setAmount('custom');
          }}
          inputLabel={t('accounts.realizeTab.amountAria')}
          suffix={poolCoin(tab.pool)}
          placeholder={t('accounts.realizeTab.upToShort', { amount: num(allNet, 0) })}
          bad={customOverAll}
          boxClassName="w-40"
          presetsLabel={t('accounts.realizeTab.amountPresets')}
          preset={amount === 'custom' ? null : amount}
          onPreset={setAmount}
          presets={[
            { value: 'clear', label: t('accounts.realizeTab.debtPreset', { amount: num(debtNet, 0), coin: poolCoin(tab.pool) }), disabled: Math.round(debtNet) === 0 },
            { value: 'all', label: t('accounts.realizeTab.allPreset', { amount: num(allNet, 0), coin: poolCoin(tab.pool) }), disabled: !all },
          ]}
        />
        {sentence && <p className="num text-xs text-ink-300">{sentence}</p>}
      </div>

      {active && active.legs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className={microLabelClass}>{t('accounts.realizeTab.closeReopen')}</span>
          <ol className="flex flex-col gap-1">
            {active.legs.flatMap((leg) => {
              const close = (
                <span className="num">
                  {t('accounts.realizeTab.legPart', { coin: leg.base, side: t(leg.side === 'LONG' ? 'common.long' : 'common.short'), size: sizeText(leg.qty), held: sizeText(leg.positionQty) })}
                </span>
              );
              const convert = leg.convert && leg.convert.feeUsd > 0 ? (
                <span className="num inline-flex items-center gap-1.5">
                  <Term label={t('accounts.rebalanceRealize.convertAction', { amount: num(leg.convert.amount, 0), coin: poolCoin(leg.pool) })} text={HOVER.convert} />
                  <ArrowRight size={12} aria-hidden className="shrink-0 text-ink-500" />
                  {WALLET_LABEL[poolKey(CONVERT_TO[leg.pool])]}
                </span>
              ) : null;
              return convert ? [{ key: `${leg.symbol}:convert`, text: convert }, { key: leg.symbol, text: close }] : [{ key: leg.symbol, text: close }];
            }).map((line, index) => (
              <li key={line.key} className="flex items-center gap-3 rounded border border-ink-800 px-3 py-1.5 text-xs text-ink-100">
                <span className="num w-4 shrink-0 text-ink-400">{index + 1}</span>
                {line.text}
              </li>
            ))}
          </ol>
        </div>
      )}

      {active && (!refusal || sliceRefused) && active.legs.length > 0 && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className={microLabelClass}>{t('accounts.realizeTab.orders')}</span>
            <ExecModeToggle
              ariaLabel={t('accounts.realizeTab.orders')}
              fill
              value={exec}
              onChange={setExec}
              order={EXEC_ORDER}
              labels={{ maker: execLabel('maker'), market: execLabel('market') }}
            />
          </div>

          {slice && (
            <SliceSizeRow
              sizeUsd={slice.count === 1 ? Math.min(shownSliceUsd, slice.usd) : shownSliceUsd}
              count={slice.count}
              open={tableOpen}
              onToggle={() => setTableOpen(!tableOpen)}
              table={{ options, value: shownSliceUsd, exec, onPick: pickSlice, customText: sliceText, onCustom: typeSlice, coin: lead?.base }}
            />
          )}

          {rows.length > 0 && <TotalCost rows={rows} />}

          <RebalanceBeforeAfter rows={after} mode="after" />
        </>
      )}

      {refusal ? (
        <VerdictAlert tone="warn" text={refusal.title} sub={refusal.body} />
      ) : (
        <RebalanceModalFooter
          rows={[]}
          verdict={warning && !sentence ? <NotHedgedLine text={warning} /> : undefined}
          holdLabel={pricing ? t('accounts.rebalanceModal.pricing') : t('accounts.realizeTab.holdRealize')}
          optional={false}
          stale={false}
          quoteStale={amount === 'custom' && customQuery.isError}
          lock={lock}
          pricing={pricing}
          holdMs={holdMs}
          disabled={lock !== null || start.isPending || pricing || sliceInvalid || !active || active.legs.length === 0 || !(Math.round(net) >= 1)}
          onRefresh={() => void customQuery.refetch()}
          onConfirm={confirm}
        />
      )}
    </>
  );
}
