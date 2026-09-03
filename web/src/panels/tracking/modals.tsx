/**
 * The three dialogs of the preview tracking UX. All of them write EVENTS via
 * useLedger — none of them places orders, and the footer of each says so.
 */
import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { SegmentedToggle } from '../../components/SegmentedToggle';
import { fmtDateLocal, fmtPct, fmtTokenQty, fmtUsd, fmtUsdCompact, prettyVenue } from '../../lib/fmt';
import type { EnrollSpec } from './useLedger';
import type { PoolLeg, TrancheView, TrayLeg } from './model';

const SIDE_TEXT: Record<'LONG' | 'SHORT', string> = {
  LONG: 'text-emerald-400',
  SHORT: 'text-rose-400',
};

export const unitOf = (p: PoolLeg): string => (p.kind === 'perp' ? p.base : (p.collateral ?? p.base));

export function legTitle(p: PoolLeg): string {
  return `${p.kind === 'boros' ? 'Boros' : 'Perp'} · ${prettyVenue(p.venue)}`;
}

export function LegLine({ p, qty }: { p: PoolLeg; qty: number }) {
  return (
    <span>
      <span className={`font-medium ${SIDE_TEXT[p.side]}`}>{p.side.toLowerCase()}</span>{' '}
      <span className="text-ink-100">{p.base}</span>
      <span className="text-ink-400"> · {legTitle(p)} · </span>
      <span className="num text-ink-200">{fmtTokenQty(qty, unitOf(p))}</span>
    </span>
  );
}

const toLocalInput = (sec: number): string => {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string): number | null => {
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

function Footer({ onCancel, onConfirm, confirmLabel, disabled }: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  disabled: boolean;
}) {
  return (
    <div className="mt-4 flex items-center justify-between gap-3 border-t border-ink-800 pt-3">
      <span className="text-[11px] text-ink-500">Changes tracking only — it places no orders.</span>
      <span className="flex gap-2">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={disabled} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add a leg (the "pull in")
// ---------------------------------------------------------------------------

interface EnrollProps {
  title: string;
  /** Ranked best-first; the top one is preselected. */
  candidates: TrayLeg[];
  /** Tray direction: pick the destination position here too. */
  destinations?: {
    options: { sid: string; label: string }[];
    value: string;
    onChange: (sid: string) => void;
  };
  /** USD already banked by the DESTINATION for a given leg key. Guards the
   * double-count: "its whole history" on a leg whose past is partly banked
   * here would book that past twice. */
  bankedUsdByLeg?: Record<string, number>;
  /** The destination strategy's creation instant — enrollment never predates
   * it (a leg's earlier life is not this strategy's). */
  minT?: number;
  /** Legs the destination recently banked — offering "this replaces one of
   * them" turns the enrollment into a recorded VENUE SWITCH, whose price gap
   * is the strategy's slippage (the simultaneous-entry gap no longer applies). */
  recentBanked?: { key: string; label: string }[];
  onConfirm: (spec: EnrollSpec) => void;
  onClose: () => void;
}

export function EnrollModal({ title, candidates, destinations, bankedUsdByLeg, minT, recentBanked, onConfirm, onClose }: EnrollProps) {
  const [picked, setPicked] = useState(0);
  const cand = candidates[picked] ?? null;
  const [qtyText, setQtyText] = useState<string | null>(null);
  const bankedHere = cand ? (bankedUsdByLeg?.[cand.pool.key] ?? 0) : 0;
  const [countFromChoice, setCountFromChoice] = useState<'since-open' | 'fresh' | null>(null);
  const countFrom = countFromChoice ?? (bankedHere !== 0 ? 'fresh' : 'since-open');
  const [when, setWhen] = useState<string | null>(null);
  const [migrateFrom, setMigrateFrom] = useState<string>('');
  const [migrateCostText, setMigrateCostText] = useState('0');
  const migrateCost = Number(migrateCostText);
  const migrateOk = migrateFrom === '' || Number.isFinite(migrateCost);

  const qty = qtyText === null ? (cand?.freeQty ?? 0) : Number(qtyText);
  // Default to the leg's own open, floored at the strategy's creation — a
  // leg's earlier life is not this strategy's.
  const rawDefault = cand?.pool.openedAt ?? Math.floor(Date.now() / 1000);
  const defaultT = minT !== undefined ? Math.max(rawDefault, minT) : rawDefault;
  // "Only from now on" freezes the baseline at the live net — pairing that
  // with a back-dated window would count a week of capital-time against zero
  // countable PnL, so fresh pins the date to now.
  const t =
    countFrom === 'fresh'
      ? Math.floor(Date.now() / 1000)
      : when === null
        ? defaultT
        : fromLocalInput(when);
  const qtyOk = cand !== null && Number.isFinite(qty) && qty > 0 && qty <= cand.freeQty * (1 + 1e-9);
  const tooEarly = t !== null && minT !== undefined && t < minT - 60;
  const tOk = t !== null && t <= Date.now() / 1000 + 60 && !tooEarly;

  return (
    <Modal title={title} onClose={onClose} widthClass="w-[560px]">
      {candidates.length === 0 ? (
        <p className="text-sm text-ink-400">
          Every leg the venues report is already part of a position. Open a new leg first, or retire
          one from another position to free it up.
        </p>
      ) : (
        <>
          {destinations && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
                Into which position?
              </p>
              <select
                className="input w-full"
                value={destinations.value}
                onChange={(e) => destinations.onChange(e.target.value)}
              >
                {destinations.options.map((o) => (
                  <option key={o.sid} value={o.sid}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
            Which leg?
          </p>
          <div className="flex flex-col gap-1">
            {candidates.map((c, i) => (
              <label
                key={c.pool.key}
                className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  i === picked ? 'border-cyan-500/50 bg-cyan-500/5' : 'border-ink-800 hover:border-ink-600'
                }`}
              >
                <input
                  type="radio"
                  className="accent-cyan-500"
                  checked={i === picked}
                  onChange={() => {
                    setPicked(i);
                    setQtyText(null);
                    setWhen(null);
                  }}
                />
                <LegLine p={c.pool} qty={c.freeQty} />
                <span className="ml-auto text-xs text-ink-500">
                  {c.pool.openedAt ? `opened ${fmtDateLocal(c.pool.openedAt)}` : 'open date unknown'}
                </span>
              </label>
            ))}
          </div>

          {cand && (
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
                  How much of it?
                </p>
                <div className="flex items-center gap-2">
                  <input
                    className="input w-32"
                    inputMode="decimal"
                    value={qtyText ?? String(cand.freeQty)}
                    onChange={(e) => setQtyText(e.target.value)}
                  />
                  <span className="text-xs text-ink-400">{unitOf(cand.pool)}</span>
                  <button type="button" className="btn-ghost-xs" onClick={() => setQtyText(null)}>
                    All
                  </button>
                </div>
                {!qtyOk && (
                  <p className="mt-1 text-xs text-rose-400">
                    Up to {fmtTokenQty(cand.freeQty, unitOf(cand.pool))} is unassigned.
                  </p>
                )}
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
                  Part of this position since…
                </p>
                <input
                  type="datetime-local"
                  className="input w-full disabled:opacity-50"
                  value={countFrom === 'fresh' ? toLocalInput(Math.floor(Date.now() / 1000)) : (when ?? toLocalInput(defaultT))}
                  min={minT !== undefined ? toLocalInput(minT) : undefined}
                  max={toLocalInput(Math.floor(Date.now() / 1000))}
                  disabled={countFrom === 'fresh'}
                  title={countFrom === 'fresh' ? '"Only from now on" starts counting now — the date follows.' : undefined}
                  onChange={(e) => setWhen(e.target.value)}
                />
                {!tOk && (
                  <p className="mt-1 text-xs text-rose-400">
                    {tooEarly
                      ? `This position started ${minT !== undefined ? fmtDateLocal(minT) : ''} — a leg can't join it earlier than that.`
                      : 'Pick a time in the past.'}
                  </p>
                )}
              </div>
            </div>
          )}

          {cand && (
            <div className="mt-4">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
                What counts toward this position?
              </p>
              <SegmentedToggle
                value={countFrom}
                onChange={(v) => setCountFromChoice(v as 'since-open' | 'fresh')}
                options={[
                  { value: 'since-open', label: 'Its whole history' },
                  { value: 'fresh', label: 'Only from now on' },
                ]}
              />
              <p className="mt-1 text-xs text-ink-500">
                {countFrom === 'since-open'
                  ? `Everything the leg has earned or paid so far (${fmtUsd(cand.pool.netUsd * (qtyOk ? qty / Math.max(cand.pool.qty, 1e-9) : 0))}) counts as this position's PnL.`
                  : 'Its past PnL stays outside; only what happens after enrollment counts.'}
              </p>
              {countFrom === 'since-open' && bankedHere !== 0 && (
                <p className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400">
                  This position already banked {fmtUsd(bankedHere)} from this leg — counting its
                  whole history again would book that twice. &quot;Only from now on&quot; is the
                  consistent choice.
                </p>
              )}
            </div>
          )}

          {cand && recentBanked && recentBanked.length > 0 && (
            <div className="mt-4">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
                Venue switch?
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="input"
                  value={migrateFrom}
                  onChange={(e) => setMigrateFrom(e.target.value)}
                >
                  <option value="">No — a fresh leg</option>
                  {recentBanked.map((b) => (
                    <option key={b.key} value={b.label}>
                      replaces {b.label}
                    </option>
                  ))}
                </select>
                {migrateFrom !== '' && (
                  <span className="flex items-center gap-1">
                    <span className="text-xs text-ink-400">switch cost $</span>
                    <input
                      className="input w-24"
                      inputMode="decimal"
                      value={migrateCostText}
                      onChange={(e) => setMigrateCostText(e.target.value)}
                    />
                  </span>
                )}
              </div>
              {migrateFrom !== '' && (
                <p className="mt-1 text-xs text-ink-500">
                  ≈ (old leg&apos;s close − this leg&apos;s entry) × size, signed (negative =
                  favorable). Replaces the pair&apos;s entry-slippage charge — the two legs were
                  never entered together. The server replay computes this exactly from the fills.
                </p>
              )}
            </div>
          )}

          <Footer
            onCancel={onClose}
            confirmLabel="Add leg"
            disabled={!qtyOk || !tOk || !migrateOk}
            onConfirm={() => {
              if (!cand || t === null) return;
              onConfirm({
                pool: cand.pool,
                qty,
                t,
                countFrom,
                ...(migrateFrom !== ''
                  ? { migration: { from: migrateFrom, costUsd: migrateCost } }
                  : {}),
              });
            }}
          />
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Retire (bank + leave the strategy; the venue position lives on)
// ---------------------------------------------------------------------------

interface RetireProps {
  tv: TrancheView;
  onConfirm: (qty: number | null, pnlOverride?: number) => void;
  onClose: () => void;
}

export function RetireModal({ tv, onConfirm, onClose }: RetireProps) {
  const missing = tv.pool === null;
  const [qtyText, setQtyText] = useState<string | null>(null);
  const [pnlText, setPnlText] = useState('0');
  const all = qtyText === null;
  const qty = all ? tv.tranche.qty : Number(qtyText);
  const qtyOk = Number.isFinite(qty) && qty > 0 && qty <= tv.tranche.qty * (1 + 1e-9);
  const frac = tv.tranche.qty > 1e-9 ? qty / tv.tranche.qty : 0;
  const pnlOverride = missing ? Number(pnlText) : undefined;
  const pnlOk = !missing || Number.isFinite(pnlOverride);
  const unit = tv.pool ? unitOf(tv.pool) : tv.tranche.leg.kind === 'perp' ? '' : '';

  return (
    <Modal title="Retire from this position" onClose={onClose} widthClass="w-[480px]">
      <p className="text-sm text-ink-300">
        The retired share stops counting from now on, and what it has contributed so far is{' '}
        <span className="text-ink-100">banked</span> into this position&apos;s PnL — the number
        doesn&apos;t jump when the leg later closes or moves elsewhere.
        {!missing && ' The venue position itself is untouched and becomes available to other positions.'}
      </p>
      {missing && (
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          The venue no longer reports this leg, so its final PnL can&apos;t be read live. Enter it if
          you know it — the production version reads it from the venue&apos;s history automatically.
        </p>
      )}
      <div className="mt-4 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-400">How much?</span>
        <input
          className="input w-32"
          inputMode="decimal"
          value={qtyText ?? String(tv.tranche.qty)}
          onChange={(e) => setQtyText(e.target.value)}
        />
        {unit && <span className="text-xs text-ink-400">{unit}</span>}
        <button type="button" className="btn-ghost-xs" onClick={() => setQtyText(null)}>
          All
        </button>
      </div>
      {missing ? (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-ink-400">
            Final PnL (USD)
          </span>
          <input className="input w-32" inputMode="decimal" value={pnlText} onChange={(e) => setPnlText(e.target.value)} />
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-500">
          Banks {fmtUsd(tv.contributionUsd * (qtyOk ? frac : 0))} of contribution earned since{' '}
          {fmtDateLocal(tv.tranche.t)}.
        </p>
      )}
      <Footer
        onCancel={onClose}
        confirmLabel="Retire"
        disabled={!qtyOk || !pnlOk}
        onConfirm={() => onConfirm(all ? null : qty, pnlOverride)}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Adjust (restate a tranche: size / effective time / entry)
// ---------------------------------------------------------------------------

interface AdjustProps {
  tv: TrancheView;
  /** The strategy's creation instant — the floor under the date. */
  minT?: number;
  onConfirm: (patch: { qty?: number; t?: number; entry?: number | null }) => void;
  onClose: () => void;
}

export function AdjustModal({ tv, minT, onConfirm, onClose }: AdjustProps) {
  const isBoros = tv.tranche.leg.kind === 'boros';
  const [qtyText, setQtyText] = useState(String(tv.tranche.qty));
  const [when, setWhen] = useState(toLocalInput(tv.tranche.t));
  const [entryText, setEntryText] = useState(() => {
    if (tv.tranche.base.entry === undefined) return '';
    return isBoros ? String(tv.tranche.base.entry * 100) : String(tv.tranche.base.entry);
  });

  const qty = Number(qtyText);
  const maxQty = tv.pool ? tv.pool.qty : tv.tranche.qty;
  const qtyOk = Number.isFinite(qty) && qty > 0 && qty <= maxQty * (1 + 1e-9);
  const t = fromLocalInput(when);
  const tooEarly = t !== null && minT !== undefined && t < minT - 60;
  const tOk = t !== null && t <= Date.now() / 1000 + 60 && !tooEarly;
  const entryTrim = entryText.trim();
  const entryNum = entryTrim === '' ? null : isBoros ? Number(entryTrim) / 100 : Number(entryTrim);
  const entryOk = entryNum === null || (Number.isFinite(entryNum) && entryNum > 0);
  const venueEntry = tv.pool?.entry ?? null;

  const changed =
    qty !== tv.tranche.qty ||
    t !== tv.tranche.t ||
    (entryNum ?? undefined) !== tv.tranche.base.entry;

  return (
    <Modal title="Adjust this tranche" onClose={onClose} widthClass="w-[480px]">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">Size</p>
          <div className="flex items-center gap-2">
            <input className="input w-32" inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} />
            {tv.pool && <span className="text-xs text-ink-400">{unitOf(tv.pool)}</span>}
          </div>
          {!qtyOk && (
            <p className="mt-1 text-xs text-rose-400">The venue holds {maxQty} in total.</p>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
            Part of this position since
          </p>
          <input
            type="datetime-local"
            className="input w-full"
            value={when}
            min={minT !== undefined ? toLocalInput(minT) : undefined}
            max={toLocalInput(Math.floor(Date.now() / 1000))}
            onChange={(e) => setWhen(e.target.value)}
          />
          {!tOk && (
            <p className="mt-1 text-xs text-rose-400">
              {tooEarly
                ? `This position started ${minT !== undefined ? fmtDateLocal(minT) : ''} — nothing joins it earlier.`
                : 'Pick a time in the past.'}
            </p>
          )}
        </div>
      </div>
      <div className="mt-4">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
          {isBoros ? 'What rate did this tranche lock? (%)' : 'What did this tranche pay? (entry price)'}
        </p>
        <div className="flex items-center gap-2">
          <input
            className="input w-40"
            inputMode="decimal"
            placeholder={
              venueEntry !== null
                ? `venue: ${isBoros ? fmtPct(venueEntry) : fmtUsd(venueEntry)}`
                : 'venue figure'
            }
            value={entryText}
            onChange={(e) => setEntryText(e.target.value)}
          />
          {entryTrim !== '' && (
            <button type="button" className="btn-ghost-xs" onClick={() => setEntryText('')}>
              Use venue figure
            </button>
          )}
        </div>
        {!entryOk && <p className="mt-1 text-xs text-rose-400">Must be a positive number.</p>}
        <p className="mt-1 text-xs text-ink-500">
          Blank = the venue&apos;s own blended figure. Assert one when this tranche&apos;s fills
          entered at a different level than the blend.
        </p>
      </div>
      <Footer
        onCancel={onClose}
        confirmLabel="Apply"
        disabled={!qtyOk || !tOk || !entryOk || !changed}
        onConfirm={() => {
          if (t === null) return;
          onConfirm({ qty, t, entry: entryNum });
        }}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Strategy start date — the one date everything else follows
// ---------------------------------------------------------------------------

export function StartDateModal({
  startedAt,
  onConfirm,
  onClose,
}: {
  startedAt: number;
  onConfirm: (t: number) => void;
  onClose: () => void;
}) {
  const [when, setWhen] = useState(toLocalInput(startedAt));
  const t = fromLocalInput(when);
  const tOk = t !== null && t <= Date.now() / 1000 + 60;
  return (
    <Modal title="When did this strategy start?" onClose={onClose} widthClass="w-[440px]">
      <p className="text-sm text-ink-300">
        Set it to when you consider the strategy begun — when you locked the rate, or when enough
        legs were in place. Every leg then follows suit:{' '}
        <span className="text-ink-100">
          it enrolls at the later of this date and when the leg itself became available
        </span>
        , and whatever a leg earned before that is not this strategy&apos;s.
      </p>
      <input
        type="datetime-local"
        className="input mt-3 w-full"
        value={when}
        max={toLocalInput(Math.floor(Date.now() / 1000))}
        onChange={(e) => setWhen(e.target.value)}
      />
      {!tOk && <p className="mt-1 text-xs text-rose-400">Pick a time in the past.</p>}
      <Footer
        onCancel={onClose}
        confirmLabel="Apply"
        disabled={!tOk || t === startedAt}
        onConfirm={() => {
          if (t !== null) onConfirm(t);
        }}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits for the card / tray
// ---------------------------------------------------------------------------

export function usdCompact(n: number): string {
  return fmtUsdCompact(n);
}
