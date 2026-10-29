/**
 * The POSITIONS home: the ASSET-GROUPED tracking view. One card per
 * underlying asset (ETH, BTC, …) — no strategies, no enrollment, no
 * rollover lifecycle:
 *
 *   1. Hedge status: what's missing, per venue, for a perfect hedge — and
 *      per-leg exclusions for positions that aren't part of the farm.
 *   2. Lifetime PnL + capital since a user-chosen start date, from the
 *      venues' own records (open positions live, closed ones from history).
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AccountsAlert } from '../accounts/AccountsUi';
import {
  importAssetPrefs,
  useAccount,
  useAssetPrefs,
  useAssetView,
  useAssetViewWindows,
  useBorosAgent,
  useFees,
  usePatchAssetPrefs,
  usePositions,
  useRebate,
  type AssetPrefsPatch,
} from '../../api/queries';
import type { AssetViewPrefs } from '../../api/types';
import { EmptyState } from '../../components/EmptyState';
import { QueryError } from '../../components/QueryError';
import { TableSkeleton } from '../../components/Skeleton';
import { SignedNumber } from '../../components/SignedNumber';
import { fmtPct, fmtUsd, num } from '../../lib/fmt';
import { lineFor as lineIn, liquidationLines } from '../../lib/liquidation';
import { bookKey, useBookId } from '../bookId';
import { short } from '../HomeControls';
import { ConnectWalletButton } from '../../components/ConnectWalletButton';
import { isSameAddress, useActiveWallet, useTrackedAddress } from '../trackedAddress';
import { assetIsActive, deriveAsset, SECONDS_IN_YEAR } from './assetModel';
import { clearLegacyPrefs, dropLegacyKeys, legacyExclusionsFor, legSinceParam, readLegacyPrefs } from './assetPrefsStore';
import { AssetCard } from './AssetCard';
import { sizesForWholeExclusions } from './excludeLeg';

const NO_PREFS: AssetViewPrefs = { sinceByAsset: {}, exclusions: {}, legSince: {} };

export function AssetsHome() {
  const { t } = useTranslation();
  const { address } = useTrackedAddress();
  const viewOnly = useActiveWallet().viewOnly;
  const loggedInRoot = useBorosAgent().data?.root ?? null;
  const book = bookKey(useBookId(address));

  const [legacy, setLegacy] = useState<'none' | 'moving' | 'failed'>(() =>
    readLegacyPrefs() === null ? 'none' : 'moving',
  );
  const moving = useRef(false);
  useEffect(() => {
    if (legacy !== 'moving' || moving.current) return;
    moving.current = true;
    importAssetPrefs(readLegacyPrefs()).then(
      () => {
        clearLegacyPrefs();
        setLegacy('none');
      },
      () => setLegacy('failed'),
    );
  }, [legacy]);

  const prefsQuery = useAssetPrefs(book, legacy !== 'moving' && address !== null);
  const savePrefs = usePatchAssetPrefs(book);
  const [legacyRev, bumpLegacy] = useReducer((n: number) => n + 1, 0);
  const legacyExclusions = useMemo(
    () => (legacy === 'failed' ? legacyExclusionsFor(book) : {}),
    [legacy, book, legacyRev],
  );
  const prefs = useMemo(() => {
    const saved = prefsQuery.data ?? NO_PREFS;
    return legacy === 'failed' ? { ...saved, exclusions: { ...legacyExclusions, ...saved.exclusions } } : saved;
  }, [prefsQuery.data, legacy, legacyExclusions]);
  const save = (patch: AssetPrefsPatch) =>
    savePrefs.mutate(patch, {
      onSuccess: () => {
        if (legacy !== 'failed') return;
        dropLegacyKeys(book, patch);
        bumpLegacy();
      },
    });

  const legSince = legSinceParam(prefs.legSince);
  const query = useAssetView(address, undefined, legSince);
  const data = query.data;
  const sized = useRef(new Set<string>());
  useEffect(() => {
    if (legacy === 'moving' || !data || !prefsQuery.data) return;
    const legs = data.assets.flatMap((g) => g.borosOpen);
    const fresh = Object.entries(sizesForWholeExclusions(prefsQuery.data.exclusions, legs)).filter(
      ([key]) => !sized.current.has(`${book}|${key}`),
    );
    if (fresh.length === 0) return;
    for (const [key] of fresh) sized.current.add(`${book}|${key}`);
    save({ exclusions: Object.fromEntries(fresh) });
  }, [legacy, data, prefsQuery.data, book]);
  // The account's own fee schedule (VIP tier) — prices the pairs' exit-fee
  // estimate; the model falls back to a flat rate while it loads.
  const feeRows = useFees().data;
  // The account's settlement-fee rebate config — discounts the FORWARD locked-rate
  // math (per market, per mode); realized rebate rides on each history row. Null
  // when not rebated. Only ever applied to the account this install is logged in
  // AS: the rebate is the agent-owner's, so a tracked/view-only address earns no
  // forward discount (matches the server-side gate on the realized rebateUsd join).
  const currentRebate = useRebate().data ?? null;
  const viewingOwn = address !== null && loggedInRoot !== null && isSameAddress(address, loggedInRoot);
  const rebate = viewingOwn ? currentRebate : null;
  const extraSinces = useMemo(
    () => [...new Set(Object.values(prefs.sinceByAsset).filter((n) => n >= 0))],
    [prefs.sinceByAsset],
  );
  const windows = useAssetViewWindows(address, extraSinces, legSince);

  const derived = useMemo(
    () =>
      (data?.assets ?? [])
        .map((g) => {
          const stored: number | undefined = prefs.sinceByAsset[g.base];
          const win = stored !== undefined ? windows.bySince.get(stored) : undefined;
          const windowFailed = stored !== undefined && !win && windows.errorBySince.has(stored);
          const full = win ? (win.assets.find((a) => a.base === g.base) ?? { ...g, perpClosed: [], borosHistory: [] }) : g;
          // A view-only wallet still sees the connected Gate account's perps:
          // view-only blocks trading and the owner's own figures (the rebate,
          // gated above), never the positions.
          const group = full;
          const meta = win ?? data;
          const sinceSec = meta?.sinceSec ?? 0;
          return {
            group,
            sinceSec,
            storedSinceSec: stored,
            backfilling: meta?.coverage.backfilling === true,
            windowPending: stored !== undefined && !win && !windowFailed,
            derived: deriveAsset(group, prefs.exclusions, sinceSec, meta?.nowSec ?? 0, feeRows, rebate),
          };
        }),
    [data, windows.bySince, windows.errorBySince, prefs.exclusions, prefs.sinceByAsset, feeRows, rebate],
  );
  /**
   * "Hide inactive pairs": on by default, the list shows only assets with
   * an open leg the farm counts (see assetIsActive). A VIEW filter only —
   * the account totals above still sum every asset, closed ones included,
   * because the money they made or lost is still the account's (his call
   * 2026-09-20). Not persisted: the default is the right start every time.
   */
  const [hideInactive, setHideInactive] = useState(true);
  const inactive = derived.filter((a) => !assetIsActive(a.group, prefs.exclusions, data?.nowSec ?? 0));
  const shown = hideInactive ? derived.filter((a) => !inactive.includes(a)) : derived;

  /* Where each coin's move liquidates the ACCOUNT. Needs margin balance,
     maintenance and the wallet equities, which the header already polls, so
     both queries are shared rather than re-fetched. */
  const accountData = useAccount().data;
  const positionsData = usePositions().data;
  const liquidation = useMemo(
    () =>
      accountData && positionsData
        ? liquidationLines(accountData, positionsData, {}, positionsData.marginTiers)
        : undefined,
    [accountData, positionsData],
  );
  /* null while the account or positions are not loaded, and for a coin with
     no priced leg in the CONNECTED account (a tracked address's history can
     name coins this account does not hold); 'unknown' when Gate's margin
     figures are not numbers, so the card says the estimate is missing rather
     than claiming safety; 'far' when no price of its own liquidates it. */
  const lineFor = (base: string) => {
    if (liquidation === undefined) return null;
    if (liquidation === null) return 'unknown' as const;
    for (const stale of liquidation.unknown) {
      if (stale.base.toUpperCase() === base.toUpperCase() && stale.sinceMs !== null) {
        return { base: stale.base, venue: stale.venue, sinceMs: stale.sinceMs };
      }
    }
    return lineIn(liquidation, base);
  };

  // Borrow interest is booked by the venue per LIABILITY COIN, not per
  // market, so it cannot sit on a card: it is charged once, here, and the
  // total then differs from the cards' sum by exactly this line.
  const interestAvailable = data?.interest?.available === true;
  const interestUsd = interestAvailable ? data!.interest!.paidUsd : 0;
  const totalPnl = derived.reduce((s, a) => s + a.derived.totals.pnlUsd, 0) - interestUsd;
  const totalCapital = derived.reduce((s, a) => s + a.derived.totals.capitalUsd, 0);
  // Blended APR: Σpnl over Σ(capital · its own elapsed clock) — each asset
  // keeps its clock, so a young asset doesn't dilute an old one's rate.
  // Both sums cover the SAME assets: one with history but no capital would
  // add PnL to the numerator while contributing zero capital-years, which
  // silently inflates the rate.
  const aprAgg = derived.reduce(
    (s, a) => {
      const d = a.derived;
      if (d.clockStartSec === null || !data || !(d.totals.capitalUsd > 0)) return s;
      return {
        pnl: s.pnl + d.totals.pnlUsd,
        capYears: s.capYears + d.totals.capitalUsd * ((data.nowSec - d.clockStartSec) / SECONDS_IN_YEAR),
      };
    },
    { pnl: 0, capYears: 0 },
  );
  const blendedApr = aprAgg.capYears > 0 ? (aprAgg.pnl - interestUsd) / aprAgg.capYears : null;
  const header = (
    <div className="mb-4 flex flex-wrap items-baseline gap-2">
      <h2
        className="text-[16px] font-semibold leading-[19.36px] text-ink-50"
        title={t('assets.home.headingTitle')}
      >
        {t('assets.home.heading')}
      </h2>
      {address && <span className="num text-xs text-ink-500">{short(address)}</span>}
      {address && (
        <label
          className="ml-auto flex cursor-pointer items-center gap-2 whitespace-nowrap text-xs text-ink-300"
          title={t('assets.home.hideInactiveTitle')}
        >
          <input type="checkbox" className="chk" checked={hideInactive} onChange={(e) => setHideInactive(e.target.checked)} />
          <span>{t('assets.home.hideInactive')}</span>
          {hideInactive && inactive.length > 0 && <span className="num text-ink-500">({inactive.length})</span>}
        </label>
      )}
    </div>
  );

  if (!address) {
    return (
      <section>
        {header}
        <EmptyState
          icon="✦"
          title={t('assets.home.connectTitle')}
          hint={t('assets.home.connectHint')}
          action={
            <div className="w-72 max-w-full">
              <ConnectWalletButton />
            </div>
          }
        />
      </section>
    );
  }

  if (prefsQuery.isError || query.isError) {
    return (
      <section>
        {header}
        <QueryError
          title={t('assets.home.loadError')}
          error={prefsQuery.error ?? query.error}
          onRetry={() => {
            if (prefsQuery.isError) void prefsQuery.refetch();
            if (query.isError) void query.refetch();
          }}
        />
      </section>
    );
  }

  if (!data || !prefsQuery.data) {
    return (
      <section>
        {header}
        <TableSkeleton rows={6} cols={5} />
      </section>
    );
  }

  // Boros margin per bucket — shown even for a view-only wallet (the data is
  // read-only) and even when nothing else is in the hero (collateral with no
  // open leg still has a bucket).
  const borosMargin = data.borosMargin ?? [];

  return (
    <section>
      {/* Account health lives on Accounts; here only a warning when needed. */}
      <AccountsAlert />
      {prefsQuery.data.unreadable && (
        <p className="mb-4 text-xs text-ink-300">{t('assets.home.prefsUnreadable')}</p>
      )}
      {legacy === 'failed' && (
        <p className="mb-4 text-xs text-ink-300">{t('assets.home.legacyFailed')}</p>
      )}
      {viewOnly && address && loggedInRoot && (
        <p className="mb-4 text-xs text-ink-400">
          <Trans
            i18nKey="assets.home.viewOnly"
            values={{ address: short(address), root: short(loggedInRoot) }}
            components={{ addr: <span className="num text-ink-200" />, owner: <span className="num text-ink-200" /> }}
          />
        </p>
      )}

      {/* Account hero. ONE result — what the farm kept — ranked by position:
          the figure sits left of a hairline, its supports right of it. No
          hedge status here: every asset row already carries its own hedged
          checklist, so an account-wide aggregate only repeated it (his call
          2026-09-15). */}
      {/* The mock gives the account summary the one info border and inner glow
          no other card wears, so it leads the tab instead of reading as the
          first of the per-asset cards. */}
      {(derived.length > 0 || borosMargin.length > 0) && (
      <div
        className="mb-9 flex flex-wrap items-center justify-between gap-x-10 gap-y-6 rounded border border-info/60 bg-info/[0.06] px-8 py-[30px]"
        style={{ boxShadow: 'inset 0 0 92px rgba(96,121,255,0.14)' }}
      >
        {derived.length > 0 && (
        <>
        <div className="flex min-w-0 flex-col gap-2">
          <div
            className="tip-label w-fit text-[14px] font-normal leading-[16.94px] text-ink-300"
            title={
              interestAvailable
                ? t('assets.home.totalPnlTitleWithInterest')
                : t('assets.home.totalPnlTitleNoInterest')
            }
          >
            {t('assets.home.totalPnl')}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="num text-[34px] font-bold leading-none tracking-[-0.01em]">
              <SignedNumber value={totalPnl} format={fmtUsd} />
            </span>
            {/* Only stated when the interest is actually known: with it
                unreadable the total IS just the cards summed, and the phrase
                would assert an arithmetic that did not happen. */}
            {interestAvailable && interestUsd > 0 && (
              <span
                className="tip-label num text-[14px] text-ink-300"
                title={(() => {
                  // Per-coin rows only when there ARE any: the rule and the
                  // total on their own read as a breakdown with nothing in it.
                  const byCoin = Object.entries(data?.interest?.byCoin ?? {});
                  return byCoin.length > 0
                    ? [
                        t('assets.home.interestPaid'),
                        ...byCoin.map(([c, n]) => `${c}\t${num(n, 2)}`),
                        '---',
                        `${t('assets.home.interestTotal')}\t${fmtUsd(interestUsd)}`,
                      ].join('\n')
                    : `${t('assets.home.interestPaid')}\t${fmtUsd(interestUsd)}`;
                })()}
              >
                {t('assets.home.afterInterest', { amount: fmtUsd(interestUsd) })}
              </span>
            )}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-9 gap-y-4 self-stretch border-ink-700 pl-0 sm:border-l sm:pl-9">
          <div className="flex flex-col gap-2">
            <div
              className="tip-label w-fit text-[14px] font-normal leading-[16.94px] text-ink-300"
              title={t('assets.home.aprTitle')}
            >
              {t('assets.home.apr')}
            </div>
            <div className="num text-[24px] font-bold leading-[29.05px]">
              {blendedApr !== null ? <SignedNumber value={blendedApr} format={fmtPct} /> : '—'}
            </div>
          </div>
          <div className="flex flex-col gap-2 border-l border-ink-700 pl-9">
            <div className="text-[14px] font-normal leading-[16.94px] text-ink-300">{t('assets.home.capital')}</div>
            <div className="num text-[24px] font-semibold leading-[29.05px] text-ink-50">{fmtUsd(totalCapital)}</div>
          </div>
        </div>
        </>
        )}

      </div>
      )}

      {header}

      {derived.length === 0 ? (
        <EmptyState
          icon="◦"
          title={t('assets.home.emptyTitle')}
          hint={t('assets.home.emptyHint')}
        />
      ) : (
        <div className="flex flex-col gap-8">
          {shown.length === 0 && (
            <p className="rounded-md border border-dashed border-ink-700 px-3 py-3 text-center text-sm text-ink-500">
              {t('assets.home.allInactive', { n: inactive.length })}
            </p>
          )}
          {shown.map(({ group, derived: d, sinceSec, storedSinceSec, backfilling, windowPending }) => (
            <AssetCard
              key={group.base}
              group={group}
              derived={d}
              sinceSec={sinceSec}
              windowPending={windowPending}
              storedSinceSec={storedSinceSec}
              defaultSinceSec={data.defaultSinceSec}
              backfilling={backfilling}
              supportedCoins={data.supportedCoins}
              onChangeSince={(sec) =>
                save({ sinceByAsset: { [group.base]: sec !== undefined && sec >= 0 ? sec : null } })
              }
              liquidation={lineFor(group.base)}
              exclusions={prefs.exclusions}
              onExclude={(key, value) => save({ exclusions: { [key]: value ?? null } })}
              legSince={prefs.legSince}
              onLegSince={(key, sec) =>
                save({ legSince: { [key]: sec !== undefined && sec > 0 ? sec : null } })
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
