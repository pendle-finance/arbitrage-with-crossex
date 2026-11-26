import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRealizeCustom, useStartRebalance } from '../api/queries';
import type { Pool, RealizeExec, RealizePlan, RealizeTab as RealizeTabData, RealizeTwap, RealizeTwapTargets, RebalanceView } from '../api/types';
import { AmountPresets } from '../components/AmountPresets';
import { EmptyState } from '../components/EmptyState';
import { OrdersGroup, perMode } from '../components/OrdersGroup';
import { TokenIcon } from '../components/AssetIcon';
import { ListPicker } from '../components/ListPicker';
import { SignedNumber } from '../components/SignedNumber';
import { Skeleton } from '../components/Skeleton';
import { microLabelClass } from '../components/Th';
import { useToast } from '../components/Toast';
import { apiErrorText } from '../lib/apiErrorText';
import { num, prettyVenue, qtyGrouped } from '../lib/fmt';
import { spanText } from '../lib/span';
import { useDebounced } from '../lib/useDebounced';
import { borrowRows, RebalanceBeforeAfter, type WalletChange } from './RebalanceBeforeAfter';
import { VerdictAlert } from './RebalanceBits';
import { keyOf, SLICE_HOVER, Term } from './RebalanceHovers';
import { RebalanceModalFooter } from './RebalanceModalFooter';
import { PlanSteps, realizeText, refusalOf, TotalCost, type CostRow, type PlanStep } from './RebalancePlanBits';
import { CONVERT_TO, HOVER, hoverCash, poolCoin, poolKey, sizeText, WALLET_LABEL } from './rebalanceCopy';
import { CUSTOM_DEBOUNCE_MS, parsedAmount } from './rebalanceModalPlan';
import type { RebalanceTab } from './rebalanceOpener';
import { costOf, hasPlan, legCostsOf, netOf, sliceOf, twapQueryOf, type Cost, type Slice } from './realizeTabCost';
import { CloseMakerSettings, useCloseMaker, withMakerWait } from './closeMaker';
import { useTwapTakerAfter } from '../trade/useTwapTakerAfter';
import { TwapArea, useTwapDefault, useTwapInput } from '../trade/TwapArea';
import { EstimateRow } from '../trade/PairTicketBits';

type AmountPick = 'clear' | 'all' | 'custom';

const TARGET: Record<AmountPick, 'clear-debt' | 'all' | 'custom'> = { clear: 'clear-debt', all: 'all', custom: 'custom' };

const TWAP_TARGET: Record<AmountPick, keyof RealizeTwapTargets> = { clear: 'clearDebt', all: 'all', custom: 'custom' };

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

const cents = (value: number): number => Math.round(value * 100) / 100;

function RealizeWallet({ view, pools, pool, onPick }: { view: RebalanceView; pools: Pool[]; pool: Pool; onPick: (pool: Pool) => void }) {
  const { t } = useTranslation();
  const walletOf = (p: Pool): string => WALLET_LABEL[poolKey(p)] ?? poolKey(p);
  const upnlOf = (p: Pool): number => view.buckets.find((b) => keyOf(b) === poolKey(p))?.upnl ?? 0;
  const shown = pools.includes(pool) ? pools : [pool, ...pools];
  return (
    <div className="flex flex-col gap-1.5">
      <span className={microLabelClass}>{t('accounts.realizeTab.walletLabel')}</span>
      <ListPicker
        label={t('accounts.realizeTab.walletLabel')}
        value={pool}
        onChange={onPick}
        rows={shown.map((p) => ({
          key: p,
          icon: <TokenIcon symbol={poolCoin(p)} size={16} />,
          name: walletOf(p),
          value: (
            <>
              {t('accounts.balances.upnl')} <SignedNumber value={upnlOf(p)} format={(n) => num(n, 0)} /> {poolCoin(p)}
            </>
          ),
        }))}
      />
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
  const [customText, setCustomText] = useState('');
  const maker = useCloseMaker();
  const twap = useTwapInput();
  const [customLead, setCustomLead] = useState(0);

  const presetOptions = withMakerWait(tab?.sliceOptions ?? [], maker.taker.sec);
  const basePriced = clearDebt && clearDebt.legs.length > 0 ? clearDebt : all;
  const splitPlan = amount === 'clear' ? clearDebt : all;
  const sliceUsd = presetOptions.find((o) => o.whole)?.sizeUsd ?? 0;
  const baseAllNet = all ? Math.max(0, netOf(all, costOf(all, exec, sliceOf(presetOptions, sliceUsd, all.legs[0], all === basePriced)))) : 0;
  const typedUsd = parsedAmount(customText);
  const customUsd = typedUsd !== null && typedUsd > 0 ? Math.min(typedUsd, baseAllNet) : null;
  const debouncedUsd = useDebounced(customUsd, CUSTOM_DEBOUNCE_MS);
  const leadQty = (amount === 'custom' ? customLead : (splitPlan?.legs[0]?.qty ?? 0));
  const twapQuery = twap.on && !twap.startBlocked ? twapQueryOf(twap.input, leadQty) : null;
  const queried = (amount === 'custom' && debouncedUsd !== null) || twapQuery !== null;
  const customQuery = useRealizeCustom(amount === 'custom' ? debouncedUsd : null, null, queried && tab ? tab.pool : null, twapQuery);
  const customPlan = customQuery.data?.realize?.custom ?? null;
  useTwapDefault(twap, amount === 'custom' ? customQuery.data?.realize?.twapDefault.custom : tab?.twapDefault[TWAP_TARGET[amount]], exec);
  const customLeadNow = customPlan?.legs[0]?.qty ?? 0;
  useEffect(() => {
    if (customLeadNow > 0) setCustomLead(customLeadNow);
  }, [customLeadNow]);
  const twapPricing = twapQuery !== null && (customQuery.isPlaceholderData || customQuery.isPending);
  const realizeTwap = twapQuery !== null && !twapPricing ? (customQuery.data?.realizeTwap ?? null) : null;
  const liveTab = twapQuery !== null && !twapPricing ? (customQuery.data?.realize ?? null) : null;
  const shownClear = liveTab ? (hasPlan(liveTab.clearDebt) ? liveTab.clearDebt : null) : clearDebt;
  const shownAll = liveTab ? (hasPlan(liveTab.all) ? liveTab.all : null) : all;
  const pricedPlan = shownClear && shownClear.legs.length > 0 ? shownClear : shownAll;
  const options = liveTab ? withMakerWait(liveTab.sliceOptions, maker.taker.sec) : presetOptions;
  const shownSliceUsd = options.find((o) => o.whole)?.sizeUsd ?? sliceUsd;
  const sliceFor = (plan: RealizePlan): Slice | null => sliceOf(options, shownSliceUsd, plan.legs[0], plan === pricedPlan);
  const twapOf = (plan: RealizePlan): RealizeTwap | null =>
    realizeTwap === null ? null : plan === shownClear ? realizeTwap.clearDebt : plan === shownAll ? realizeTwap.all : plan === customPlan ? realizeTwap.custom : null;
  const costFor = (plan: RealizePlan, mode: RealizeExec): Cost => {
    const twapEstimates = twapOf(plan)?.estimates ?? null;
    return twapEstimates ? costOf({ ...plan, estimates: twapEstimates }, mode, null) : costOf(plan, mode, sliceFor(plan));
  };
  const activeTwap = realizeTwap ? realizeTwap[TWAP_TARGET[amount]] : null;
  const twapPlan = twap.on ? (activeTwap?.plan ?? null) : null;
  const takerOff = useTwapTakerAfter(maker.taker, twap.on, twapPlan?.takerAfterSec ?? null);
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

  const customMissing = amount === 'custom' && customUsd === null;
  const customOverAll = amount === 'custom' && typedUsd !== null && customUsd !== null && typedUsd > customUsd;
  const active = amount === 'clear' ? shownClear : amount === 'all' ? shownAll : customMissing ? null : customPlan;
  const pricing = twapPricing || (amount === 'custom' && customUsd !== null && (customUsd !== debouncedUsd || customQuery.isFetching));
  const slice = active ? sliceFor(active) : null;
  const cost = active ? costFor(active, exec) : null;
  const legCosts = active && cost && !pricing ? legCostsOf(active, exec, cost) : null;
  const net = active && cost ? netOf(active, cost) : 0;
  const slicePastBook = !twap.on && options.find((o) => o.sizeUsd === shownSliceUsd)?.pastBook === true;
  const twapBlocked = twap.blockedBy(activeTwap);
  const otherRefusal = active?.refused && active.refused.reason !== 'past-book' ? active.refused : null;
  const sliceRefused = !otherRefusal && (slicePastBook || active?.refused?.reason === 'past-book');
  const refusal = !active
    ? null
    : otherRefusal
      ? refusalOf({ ...view.plans.repay, realize: active })
      : sliceRefused
        ? { title: realizeText('bookTitle'), body: t('accounts.deleverTab.bookBody') }
        : null;
  const wallet = WALLET_LABEL[poolKey(tab.pool)] ?? poolKey(tab.pool);
  const bucket = view.buckets.find((b) => keyOf(b) === poolKey(tab.pool));
  const cashNow = bucket?.cash ?? 0;
  const clearNet = shownClear ? netOf(shownClear, costFor(shownClear, exec)) : 0;
  const debtNet = clearDebt ? Math.max(0, clearNet) : 0;
  const debtText = String(Math.round(debtNet));
  const allText = String(Math.round(allNet));
  const boxText = amount === 'clear' ? debtText : amount === 'all' ? allText : customText;

  const oneOrder = !twapPlan && slice?.count === 1;
  const orderCost = perMode((mode) => (active ? costFor(active, mode).totalUsd : null));
  const orderSec = perMode((mode) => (twapPlan ? twapPlan.durationSec / Math.max(1, twapPlan.slices) : slice ? slice.seconds[mode] / Math.max(1, slice.count) : null));
  const rows: CostRow[] = cost && !(twap.on && twapBlocked)
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
            { label: hoverCash(), before: cents(cashNow), after: cents(cashNow + net - landed), unit: 'coin' },
          ],
        },
        ...(target ? [{ key: targetKey, label: WALLET_LABEL[targetKey] ?? targetKey, rows: borrowRows(target, Math.max(0, target.borrow - landed), null) }] : []),
      ]
    : [];

  const legOf = (symbol: string) => active?.legs.find((l) => l.symbol === symbol);
  const leadRow = activeTwap?.legs.reduce<RealizeTwap['legs'][number] | null>((best, row) => (best === null || row.slices > best.slices ? row : best), null) ?? null;
  const twapCoin = legOf(leadRow?.symbol ?? '')?.base ?? active?.legs[0]?.base ?? '';
  const legSlices =
    twapPlan && !twapBlocked
      ? (activeTwap?.legs ?? []).map((row) => {
          const leg = legOf(row.symbol);
          const coin = leg?.base ?? '';
          const value =
            row.plan && row.plan.lastQty !== row.plan.sliceQty
              ? t('trade.twap.area.slices', { n: row.slices, qty: qtyGrouped(row.plan.lastQty), coin })
              : t('trade.twap.area.slicesOnly', { n: row.slices });
          return { key: row.symbol, label: t('accounts.realizeTab.twapLeg', { coin, venue: prettyVenue(leg?.exchange ?? '') }), value };
        })
      : [];

  const confirm = () => {
    if (!active || !cost) return;
    start.mutate(
      {
        kind: 'realize',
        exec,
        realizeUsd: net,
        realizeTarget: TARGET[amount],
        realizePool: tab.pool,
        costUsd: cost.totalUsd,
        ...(twapPlan && twapQuery
          ? { twap: { ...twapQuery, ...(exec === 'maker' ? maker.opts : {}) } }
          : exec === 'maker'
            ? { maker: maker.opts }
            : {}),
      },
      { onSuccess: onStarted, onError: (error) => toast.push('error', apiErrorText(error)) },
    );
  };

  const sentence: string | null = customMissing
    ? t('accounts.realizeTab.typeAmount')
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
            setAmount(text.trim() === debtText && Math.round(debtNet) > 0 ? 'clear' : text.trim() === allText && all ? 'all' : 'custom');
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
        <PlanSteps
          label={t('accounts.realizeTab.closeReopen')}
          rows={active.legs.flatMap((leg, at) => {
            const close: PlanStep = {
              key: leg.symbol,
              icon: leg.base,
              text: (
                <span className="num">
                  {t('accounts.realizeTab.legPart', { coin: leg.base, side: t(leg.side === 'LONG' ? 'common.long' : 'common.short'), size: sizeText(leg.qty), held: sizeText(leg.positionQty) })}
                </span>
              ),
              usd: legCosts ? (legCosts[at] ?? null) : null,
            };
            if (!leg.convert || !(leg.convert.feeUsd > 0)) return [close];
            const convert: PlanStep = {
              key: `${leg.symbol}:convert`,
              icon: poolCoin(leg.pool),
              text: (
                <span className="num inline-flex items-center gap-1.5">
                  <Term label={t('accounts.rebalanceRealize.convertAction', { amount: num(leg.convert.amount, 0), coin: poolCoin(leg.pool) })} text={HOVER.convert} />
                  <ArrowRight size={12} aria-hidden className="shrink-0 text-ink-500" />
                  {WALLET_LABEL[poolKey(CONVERT_TO[leg.pool])]}
                </span>
              ),
              usd: legCosts ? leg.convert.feeUsd : null,
            };
            return [convert, close];
          })}
        />
      )}

      {active && (!refusal || sliceRefused) && active.legs.length > 0 && (
        <>
          <OrdersGroup value={exec} onChange={setExec} cost={orderCost} seconds={orderSec} whole={perMode(() => oneOrder)}>
              {exec === 'maker' && <CloseMakerSettings maker={maker} capSec={twapPlan?.takerAfterSec ?? null} />}
              <TwapArea on={twap.on} onToggle={twap.setOn} input={twap.input} onInput={twap.setInput} preview={activeTwap} impact={null} coin={twapCoin} />
              {legSlices.length > 1 && (
                <div className="flex flex-col gap-1.5 px-3">
                  {legSlices.map((row) => (
                    <EstimateRow key={row.key} label={row.label} value={<span className="num">{row.value}</span>} />
                  ))}
                </div>
              )}
          </OrdersGroup>

          {rows.length > 0 && <TotalCost rows={rows} />}

          <RebalanceBeforeAfter rows={after} mode="after" />
        </>
      )}

      {refusal ? (
        <VerdictAlert tone="warn" text={refusal.title} sub={refusal.body} />
      ) : (
        <RebalanceModalFooter
          rows={[]}
          holdLabel={pricing ? t('common.refreshing') : twapPlan ? t('accounts.realizeTab.holdRealizeTwap', { duration: spanText(twapPlan.durationSec) }) : t('accounts.realizeTab.holdRealize')}
          optional={false}
          stale={false}
          quoteStale={amount === 'custom' && customQuery.isError}
          lock={lock}
          pricing={pricing}
          holdMs={holdMs}
          disabled={lock !== null || start.isPending || pricing || (twap.on && twapBlocked) || (exec === 'maker' && takerOff) || !active || active.legs.length === 0 || !(Math.round(net) >= 1)}
          onRefresh={() => void customQuery.refetch()}
          onConfirm={confirm}
        />
      )}
    </>
  );
}
