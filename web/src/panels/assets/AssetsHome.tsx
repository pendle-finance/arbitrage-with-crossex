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
import { useAccount, useAssetView, useAssetViewWindows, useFees, usePositions } from '../../api/queries';
import { EmptyState } from '../../components/EmptyState';
import { QueryError } from '../../components/QueryError';
import { TableSkeleton } from '../../components/Skeleton';
import { SignedNumber } from '../../components/SignedNumber';
import { fmtPct, fmtUsd } from '../../lib/fmt';
import { lineFor as lineIn, liquidationLines } from '../../lib/liquidation';
import { useBookId } from '../bookId';
import { AddressForm, short } from '../HomeControls';
import { useTrackedAddress } from '../trackedAddress';
import { deriveAsset, SECONDS_IN_YEAR } from './assetModel';
import { legSinceParam, loadPrefs, savePrefs, type AssetViewPrefs } from './assetPrefsStore';
import { AssetCard } from './AssetCard';

export function AssetsHome() {
  const { address, setAddress } = useTrackedAddress();
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

  // Base query (all time) enumerates the assets; each asset with its OWN
  // start date reads from the extra window(s) — one request per distinct
  // date, shared across assets that agree.
  const legSince = legSinceParam(prefs.legSince);
  const query = useAssetView(address, 0, legSince);
  const data = query.data;
  // The account's own fee schedule (VIP tier) — prices the pairs' exit-fee
  // estimate; the model falls back to a flat rate while it loads.
  const feeRows = useFees().data;
  const extraSinces = useMemo(
    () => [...new Set(Object.values(prefs.sinceByAsset).filter((n) => n > 0))],
    [prefs.sinceByAsset],
  );
  const windows = useAssetViewWindows(address, extraSinces, legSince);

  const allDerived = useMemo(
    () =>
      (data?.assets ?? []).map((g) => {
        const since = prefs.sinceByAsset[g.base] ?? 0;
        const win = since > 0 ? windows.bySince.get(since) : undefined;
        // Until that window's fetch lands, the all-time numbers stand in;
        // an asset absent from a narrower window is genuinely empty there.
        const group = win ? (win.assets.find((a) => a.base === g.base) ?? { ...g, perpClosed: [], borosHistory: [] }) : g;
        const meta = win ?? data;
        return {
          group,
          sinceSec: since,
          windowPending: since > 0 && !win,
          derived: deriveAsset(group, prefs.exclusions, meta?.sinceSec ?? 0, meta?.nowSec ?? 0, feeRows),
        };
      }),
    [data, windows.bySince, prefs.exclusions, prefs.sinceByAsset, feeRows],
  );
  // Dust fold: an asset with nothing open and a negligible history total is
  // real (the sums keep it) but not worth a card — one muted line names them.
  const derived = allDerived.filter(
    (a) =>
      a.group.perpOpen.length > 0 ||
      a.group.borosOpen.length > 0 ||
      Math.abs(a.derived.totals.pnlUsd) >= 1,
  );
  const dust = allDerived.filter((a) => !derived.includes(a));

  /* Where each coin's move liquidates the ACCOUNT. Needs margin balance,
     maintenance and the wallet equities, which the header already polls, so
     both queries are shared rather than re-fetched. */
  const accountData = useAccount().data;
  const positionsData = usePositions().data;
  const liquidation = useMemo(
    () => (accountData && positionsData ? liquidationLines(accountData, positionsData) : undefined),
    [accountData, positionsData],
  );
  /* null while the account or positions are not loaded, and for a coin with
     no priced leg in the CONNECTED account (a tracked address's history can
     name coins this account does not hold); 'unknown' when Gate's margin
     figures are not numbers, so the card says the estimate is missing rather
     than claiming safety; 'far' when priced to 10x and 2% with no line. */
  const lineFor = (base: string) => {
    if (liquidation === undefined) return null;
    if (liquidation === null) return 'unknown' as const;
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
  // Legs to open (missing or short), counted the way the cards show them.
  // A book whose perps do not cancel is a second, different fact — it gets
  // its own words rather than an invisible +1 in the count.
  const gapCount = derived.reduce((s, a) => s + a.derived.gaps.length, 0);
  const nonNeutral = derived.some((a) => !a.derived.deltaNeutral);

  const header = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h2
        className="text-xs font-semibold uppercase tracking-wider text-ink-400"
        title="Every leg grouped by its underlying asset; PnL and capital are the venues' own records since your start date. Nothing here places orders."
      >
        Funding farm by asset
      </h2>
      {address && <span className="num text-xs text-ink-500">{short(address)}</span>}
    </div>
  );

  if (!address) {
    return (
      <section>
        {header}
        <EmptyState
          icon="✦"
          title="Track an address to see your farm by asset"
          hint="The asset view groups every perp and Boros leg by its underlying coin and reports the venues' own lifetime numbers."
          action={<AddressForm submitLabel="Track" onTrack={setAddress} />}
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
      {header}

      {/* Totals strip. It used to hide behind a single card as a duplicate
          of that card's hero; it now carries what no card can — borrow
          interest and the account-wide hedge status — so it always shows
          once there is anything to sum. */}
      {derived.length > 0 && (
      <div className="card mb-3 flex flex-wrap items-center gap-x-8 gap-y-2 p-4">
        {/* The two figures ARE an equation — total = earnings − interest —
            so they are written as one, boxed together. Side by side with no
            operator they read as two unrelated numbers, and the reader is
            left to guess whether the total already has the interest in it
            (it does). Each term says what it is on hover. */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded border border-ink-700 bg-ink-950/40 px-3 py-2">
          <div>
            <div
              className="text-xs uppercase tracking-wider text-ink-500"
              title={
                interestAvailable
                  ? 'What the farm kept, after the borrow interest below. This is the number to compare against your own record.'
                  : 'Borrow interest could not be read, so it is NOT subtracted here — this is the cards summed.'
              }
            >
              Total PnL
            </div>
            <div className="num text-xl font-semibold">
              <SignedNumber value={totalPnl} format={fmtUsd} plus={false} />
            </div>
          </div>
          {/* Only an equation when the right-hand side is known: with the
              interest unreadable the total IS just the cards summed, and
              "X = X − —" would assert an arithmetic that did not happen. */}
          {interestAvailable && (
          <>
          <span className="num pb-0.5 self-end text-lg text-ink-500">=</span>
          <div>
            <div
              className="text-xs uppercase tracking-wider text-ink-500"
              title="Every card's PnL added up: funding and settlements earned, less the trading fees and price basis on those legs. Borrow interest is NOT in here — it is the term to the right."
            >
              Earnings
            </div>
            <div className="num text-xl font-semibold text-ink-200">
              <SignedNumber value={totalPnl + interestUsd} format={fmtUsd} plus={false} />
            </div>
          </div>
          <span className="num pb-0.5 self-end text-lg text-ink-500">−</span>
          <div>
            <div
              className="text-xs uppercase tracking-wider text-ink-500"
              title={`Margin-borrow interest the CrossEx account paid inside this window${
                data?.interest && Object.keys(data.interest.byCoin).length > 0
                  ? ` — ${Object.entries(data.interest.byCoin)
                      .map(([c, n]) => `${n.toFixed(2)} ${c}`)
                      .join(', ')}`
                  : ''
              }. Charged on the account, not on any one position, so it is subtracted once here and appears on no card.`}
            >
              Borrow interest
            </div>
            <div className={`num text-xl font-semibold ${interestUsd > 0 ? 'text-guava' : 'text-ink-200'}`}>
              {fmtUsd(interestUsd)}
            </div>
          </div>
          </>
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-500">Capital at work</div>
          <div className="num text-xl font-semibold text-ink-200">{fmtUsd(totalCapital)}</div>
        </div>
        <div>
          <div
            className="text-xs uppercase tracking-wider text-ink-500"
            title="REALIZED so far: Σ PnL over Σ (capital × each asset's own elapsed time), annualized — approximate: capital is today's requirement. Each card's Current APR (Fixed) is the different, forward-looking number."
          >
            Realized APR ≈
          </div>
          <div className="num text-xl font-semibold">
            {blendedApr !== null ? <SignedNumber value={blendedApr} format={fmtPct} plus={false} /> : '—'}
          </div>
        </div>
        {/* The HEDGE label stays; both states are plain text under it, green
            or gold — a badge here shouted next to the figures (his call). */}
        <div className="ml-auto text-right">
          <div className="text-xs uppercase tracking-wider text-ink-500">Hedge</div>
          {gapCount === 0 && !nonNeutral ? (
            <span className="text-[13px] text-grass">fully covered ✓</span>
          ) : (
            <span className="text-[13px] text-gold">
              {gapCount > 0 && `${gapCount} leg${gapCount === 1 ? '' : 's'} to fix`}
              {gapCount > 0 && nonNeutral && ' · '}
              {nonNeutral && 'perps don’t cancel'}
            </span>
          )}
        </div>
      </div>
      )}

      {derived.length === 0 ? (
        <EmptyState
          icon="◦"
          title="No positions or history found for this address"
          hint="Open a position (or move the start date back) and the assets will appear here."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {derived.map(({ group, derived: d, sinceSec, windowPending }) => (
            <AssetCard
              key={group.base}
              group={group}
              derived={d}
              sinceSec={sinceSec}
              windowPending={windowPending}
              onChangeSince={(sec: number) => {
                update((prev) => {
                  const sinceByAsset = { ...prev.sinceByAsset };
                  if (sec > 0) sinceByAsset[group.base] = sec;
                  else delete sinceByAsset[group.base];
                  return { ...prev, sinceByAsset };
                });
              }}
              liquidation={lineFor(group.base)}
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
          {dust.length > 0 && (
            <p
              className="text-xs text-ink-600"
              title={`Nothing open and under $1 of history — left out of the totals above: ${dust
                .map(
                  (a) => `${a.group.base} ${a.derived.totals.pnlUsd < 0 ? '−' : '+'}$${Math.abs(a.derived.totals.pnlUsd).toFixed(2)}`,
                )
                .join(' · ')}`}
            >
              + {dust.length} dust asset{dust.length === 1 ? '' : 's'} ⓘ
            </p>
          )}
        </div>
      )}
    </section>
  );
}
