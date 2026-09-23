/**
 * The POSITIONS home: the ASSET-GROUPED tracking view. One card per
 * underlying asset (ETH, BTC, …) — no strategies, no enrollment, no
 * rollover lifecycle:
 *
 *   1. Hedge status: what's missing, per venue, for a perfect hedge — and
 *      per-leg exclusions for positions that aren't part of the farm.
 *   2. Lifetime PnL + capital since a user-chosen start date, from the
 *      venues' own records (open positions live, closed ones from history).
 *
 * Durable state is ONLY `crossex.assetView.v1` (start date + exclusions);
 * every number is a pure function of the venue feeds.
 */
import { useMemo, useState } from 'react';
import { useAccount, useAssetView, useAssetViewWindows, useBorosAgent, useFees, usePositions } from '../../api/queries';
import { EmptyState } from '../../components/EmptyState';
import { QueryError } from '../../components/QueryError';
import { TableSkeleton } from '../../components/Skeleton';
import { SignedNumber } from '../../components/SignedNumber';
import { fmtPct, fmtUsd, num } from '../../lib/fmt';
import { lineFor as lineIn, liquidationLines } from '../../lib/liquidation';
import { useBookId } from '../bookId';
import { short } from '../HomeControls';
import { ConnectWalletButton } from '../../components/ConnectWalletButton';
import { useActiveWallet, useTrackedAddress } from '../trackedAddress';
import { assetIsActive, deriveAsset, SECONDS_IN_YEAR, type AssetDerived } from './assetModel';
import { legSinceParam, loadPrefs, savePrefs, type AssetViewPrefs } from './assetPrefsStore';
import { AssetCard } from './AssetCard';

export function AssetsHome() {
  const { address } = useTrackedAddress();
  const gateHidden = useActiveWallet().viewOnly;
  const loggedInRoot = useBorosAgent().data?.root ?? null;
  const bookId = useBookId(address);

  const [prefs, setPrefs] = useState<AssetViewPrefs>(() => loadPrefs(bookId));
  // A book switch swaps the whole prefs record — reload, don't carry over.
  const [prefsBook, setPrefsBook] = useState(bookId);
  if (prefsBook !== bookId) {
    setPrefsBook(bookId);
    setPrefs(loadPrefs(bookId));
  }
  /**
   * FUNCTIONAL update. The leg-edit modal fires two writes on one Save
   * (exclusion, then "counted from"); built off the render-time `prefs`
   * the second spread the stale object and wiped the first — an exclusion
   * that visibly saved and then was not there.
   */
  const update = (fn: (prev: AssetViewPrefs) => AssetViewPrefs) => {
    setPrefs((prev) => {
      const next = fn(prev);
      savePrefs(bookId, next);
      return next;
    });
  };

  const legSince = legSinceParam(prefs.legSince);
  const query = useAssetView(address, undefined, legSince);
  const data = query.data;
  // The account's own fee schedule (VIP tier) — prices the pairs' exit-fee
  // estimate; the model falls back to a flat rate while it loads.
  const feeRows = useFees().data;
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
          const group = gateHidden ? { ...full, perpOpen: [], perpClosed: [] } : full;
          const meta = win ?? data;
          const sinceSec = meta?.sinceSec ?? 0;
          const d = deriveAsset(group, prefs.exclusions, sinceSec, meta?.nowSec ?? 0, feeRows);
          const shown: AssetDerived = gateHidden ? { ...d, gaps: d.gaps.filter((gap) => gap.leg !== 'perp') } : d;
          return {
            group,
            sinceSec,
            storedSinceSec: stored,
            backfilling: meta?.coverage.backfilling === true,
            windowPending: stored !== undefined && !win && !windowFailed,
            derived: shown,
          };
        })
        .filter((a) => !gateHidden || a.group.borosOpen.length > 0 || a.group.borosHistory.length > 0),
    [data, windows.bySince, windows.errorBySince, prefs.exclusions, prefs.sinceByAsset, feeRows, gateHidden],
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
  const interestUsd = !gateHidden && interestAvailable ? data!.interest!.paidUsd : 0;
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
        title="Every leg grouped by its underlying asset."
      >
        Funding farm by asset
      </h2>
      {address && <span className="num text-xs text-ink-500">{short(address)}</span>}
      {address && (
        <label
          className="ml-auto flex cursor-pointer items-center gap-2 whitespace-nowrap text-xs text-ink-300"
          title="Show only assets with an open leg. Account totals still include every asset."
        >
          <input type="checkbox" className="chk" checked={hideInactive} onChange={(e) => setHideInactive(e.target.checked)} />
          <span>Hide inactive pairs</span>
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
          title="Connect your wallet to see your farm by asset"
          hint="The asset view groups every perp and Boros leg by its underlying coin and reports the venues' own lifetime numbers."
          action={
            <div className="w-72 max-w-full">
              <ConnectWalletButton />
            </div>
          }
        />
      </section>
    );
  }

  if (query.isError) {
    return (
      <section>
        {header}
        <QueryError title="Couldn't load the asset view" error={query.error} onRetry={() => query.refetch()} />
      </section>
    );
  }

  if (!data) {
    return (
      <section>
        {header}
        <TableSkeleton rows={6} cols={5} />
      </section>
    );
  }

  return (
    <section>
      {gateHidden && loggedInRoot && (
        <p className="mb-4 text-xs text-ink-400">
          Boros legs only. Gate perps show for{' '}
          <span className="num text-ink-200">{short(loggedInRoot)}</span>.
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
      {derived.length > 0 && (
      <div
        className="mb-9 flex flex-wrap items-center justify-between gap-x-10 gap-y-6 rounded border border-info/60 bg-info/[0.06] px-8 py-[30px]"
        style={{ boxShadow: 'inset 0 0 92px rgba(96,121,255,0.14)' }}
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div
            className="tip-label w-fit text-[14px] font-normal leading-[16.94px] text-ink-300"
            title={
              gateHidden
                ? 'Boros legs only. Gate is not included.'
                : interestAvailable
                  ? 'What the farm kept, after borrow interest.'
                  : 'The cards summed. Borrow interest could not be read, so it is not subtracted.'
            }
          >
            {gateHidden ? (
              <>
                Boros PnL · <span className="num">{short(address)}</span>
              </>
            ) : (
              'Total Account PnL'
            )}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="num text-[34px] font-bold leading-none tracking-[-0.01em]">
              <SignedNumber value={totalPnl} format={fmtUsd} plus={false} />
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
                        'Borrow interest paid',
                        ...byCoin.map(([c, n]) => `${c}\t${num(n, 2)}`),
                        '---',
                        `Total\t${fmtUsd(interestUsd)}`,
                      ].join('\n')
                    : `Borrow interest paid\t${fmtUsd(interestUsd)}`;
                })()}
              >
                after {fmtUsd(interestUsd)} borrow interest
              </span>
            )}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-9 gap-y-4 self-stretch border-ink-700 pl-0 sm:border-l sm:pl-9">
          <div className="flex flex-col gap-2">
            <div
              className="tip-label w-fit text-[14px] font-normal leading-[16.94px] text-ink-300"
              title="PnL so far over capital × time, annualized. Approximate: capital is today's requirement."
            >
              Realized APR ≈
            </div>
            <div className="num text-[24px] font-bold leading-[29.05px]">
              {blendedApr !== null ? <SignedNumber value={blendedApr} format={fmtPct} plus={false} /> : '—'}
            </div>
          </div>
          <div className="flex flex-col gap-2 border-l border-ink-700 pl-9">
            <div className="text-[14px] font-normal leading-[16.94px] text-ink-300">Capital at work</div>
            <div className="num text-[24px] font-semibold leading-[29.05px] text-ink-50">{fmtUsd(totalCapital)}</div>
          </div>
        </div>
      </div>
      )}

      {header}

      {derived.length === 0 ? (
        <EmptyState
          icon="◦"
          title="No positions or history found for this address"
          hint="Open a position (or move the start date back) and the assets will appear here."
        />
      ) : (
        <div className="flex flex-col gap-8">
          {shown.length === 0 && (
            <p className="rounded-md border border-dashed border-ink-700 px-3 py-3 text-center text-sm text-ink-500">
              No active pairs — {inactive.length} inactive hidden.
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
              onChangeSince={(sec) => {
                update((prev) => {
                  const sinceByAsset = { ...prev.sinceByAsset };
                  if (sec !== undefined && sec >= 0) sinceByAsset[group.base] = sec;
                  else delete sinceByAsset[group.base];
                  return { ...prev, sinceByAsset };
                });
              }}
              liquidation={gateHidden ? null : lineFor(group.base)}
              gateHidden={gateHidden}
              exclusions={prefs.exclusions}
              onExclude={(key, value) => {
                update((prev) => {
                  const exclusions = { ...prev.exclusions };
                  if (value === undefined) delete exclusions[key];
                  else exclusions[key] = value;
                  return { ...prev, exclusions };
                });
              }}
              legSince={prefs.legSince}
              onLegSince={(key, sec) => {
                update((prev) => {
                  const next = { ...prev.legSince };
                  if (sec === undefined || !(sec > 0)) delete next[key];
                  else next[key] = sec;
                  return { ...prev, legSince: next };
                });
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
