/** The four legs as a hedging diagram (house style — hand-rolled divs, no
 * chart lib), laid out the way the hedge actually works:
 *
 *   [ Perps · Gate CrossEx ]   short ⟷ long, price PnL cancels (delta-neutral)
 *        ⇅ per venue           the perp's floating funding cancels the Boros
 *   [ On Boros — rate legs ]   leg's floating side, leaving a fixed APR
 *                              received on one venue, paid on the other; the
 *                              difference is the locked spread.
 *
 * Perp layer on top, each Boros rate leg directly below its venue's perp, the
 * Boros pair inside its own labeled border. Books that aren't the canonical
 * two-venue four-leg shape fall back to a flat list of every leg. */
import { SideChip, VenueChip } from '../components/VenueChip';
import { fmtPct, fmtTokenQty, fmtUsdCompact } from '../lib/fmt';
import type { ShareLegV1 } from '../lib/shareCodec';
import type { PositionView, VenueColumn } from './derive';

/** Every leg reads off ONE fact: a SHORT leg receives (emerald), a LONG leg
 * pays (rose) — true of the Boros fixed rate and of the perp's floating
 * funding alike, which is exactly why the pair hedges. */
const money = (side: ShareLegV1['s']) =>
  side === 'S'
    ? { verb: 'receive', gerund: 'receiving', tone: 'text-emerald-400' }
    : { verb: 'pay', gerund: 'paying', tone: 'text-rose-400' };

/** A Boros leg's fixed rate, or a stand-in when the wire omitted it. */
function FixedRate({ apr }: { apr?: number }) {
  return apr === undefined ? <>a rate</> : <span className="num">{fmtPct(apr)}</span>;
}

/** One leg box — phrased for a ~150px column: the chips carry venue/side/CX,
 * the one body line carries only what the chips can't. */
function LegCard({ leg }: { leg: ShareLegV1 }) {
  const boros = leg.k === 'b';
  const { verb, tone } = money(leg.s);
  return (
    <div className="min-w-0 rounded-lg border border-ink-700 bg-ink-950/50 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <SideChip side={leg.s === 'S' ? 'SHORT' : 'LONG'} />
        <VenueChip exchange={leg.x} crossex={!boros} />
        <span className="num ml-auto text-sm text-ink-200">{fmtUsdCompact(leg.n)}</span>
      </div>
      {leg.tn !== undefined && leg.ts !== undefined && (
        <div className="num mt-0.5 text-right text-[10px] text-ink-400">
          ({fmtTokenQty(leg.tn, leg.ts)})
        </div>
      )}
      <div className="mt-1.5 text-[11px] leading-snug text-ink-400">
        {boros ? (
          // The Boros leg swaps the two: it takes the floating side its perp
          // doesn't, and settles the difference at a fixed rate.
          <>
            {leg.s === 'S' ? 'Pay' : 'Receive'} floating,{' '}
            <span className={tone}>
              {verb} <FixedRate apr={leg.r} /> fixed
            </span>
          </>
        ) : (
          <>
            Perp · <span className={tone}>{verb}</span> floating funding
          </>
        )}
      </div>
    </div>
  );
}

/** Bordered layer with a fieldset-style label riding the top border. */
function LayerBox({
  label,
  tone,
  children,
}: {
  label: string;
  tone: 'violet' | 'cyan';
  children: React.ReactNode;
}) {
  const border = tone === 'violet' ? 'border-violet-500/30' : 'border-cyan-500/30';
  const text = tone === 'violet' ? 'text-violet-300' : 'text-cyan-300';
  return (
    <div className={`relative rounded-xl border ${border} p-1.5 pt-3 sm:p-3 sm:pt-4`}>
      <span
        className={`absolute -top-2 left-3 bg-ink-900 px-2 text-[10px] font-medium uppercase tracking-wider ${text}`}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

/** The per-venue vertical link between a perp and its Boros leg — prominent:
 * this arrow IS the hedge's mechanism. Two short lines so it holds a ~150px
 * mobile column. */
function FundingLink({ column }: { column: VenueColumn }) {
  const { gerund, tone } = money(column.boros?.s ?? 'S');
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5 py-0.5 text-center">
      <span aria-hidden className="text-xl font-semibold leading-none text-cyan-300">
        ⇅
      </span>
      <span className="text-[11px] leading-snug text-ink-300">floating funding cancels</span>
      <span className={`text-[11px] font-medium leading-snug ${tone}`}>
        net {gerund} <FixedRate apr={column.boros?.r} /> fixed
      </span>
    </div>
  );
}

export function LegDiagram({ view }: { view: PositionView }) {
  const [shortCol, longCol] = view.columns;

  if (!view.isCanonicalFourLegs || !shortCol || !longCol) {
    // Non-canonical books (extra legs, one-sided) — a plain list of EVERY leg
    // stays honest; the venue columns keep only one leg per kind and would
    // silently drop the rest of a 5+ leg book. Index keys: two same-venue
    // same-side legs are legal here.
    return (
      <section className="card p-2.5 sm:p-5">
        <h2 className="text-sm font-semibold text-ink-100">The legs</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {view.legs.map((l: ShareLegV1, i: number) => (
            <LegCard key={`${l.k}:${l.x}:${l.s}:${i}`} leg={l} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="card p-2.5 sm:p-5">
      <h2 className="text-sm font-semibold text-ink-100">The four legs, and how they hedge</h2>

      {/* A 2×2 at every width: perp pair on top, its Boros leg directly below,
          the delta-neutral badge floating over the gap between the perps. */}
      <div className="mt-4 flex flex-col gap-2.5">
        <LayerBox label="Perps · Gate CrossEx unified margin" tone="violet">
          <div className="relative grid grid-cols-2 gap-2.5 sm:gap-4">
            <LegCard leg={shortCol.perp!} />
            <LegCard leg={longCol.perp!} />
            {/* Just the glyph rides the gap (a wider badge would occlude the
                cards on a phone); its meaning sits in the caption below. */}
            <span
              aria-hidden
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md border border-cyan-500/30 bg-ink-900 px-1 text-base leading-snug text-cyan-300"
            >
              ⟷
            </span>
          </div>
          <div className="mt-2 text-center text-[10px] leading-tight text-cyan-300/90">
            delta-neutral · price PnL cancels out
          </div>
        </LayerBox>

        <div className="grid grid-cols-2 gap-2 sm:gap-3 sm:px-1">
          <FundingLink column={shortCol} />
          <FundingLink column={longCol} />
        </div>

        <LayerBox label="On Boros — the rate legs" tone="cyan">
          <div className="grid grid-cols-2 gap-2.5 sm:gap-4">
            <LegCard leg={shortCol.boros!} />
            <LegCard leg={longCol.boros!} />
          </div>
          <div className="mt-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-center text-[11px] leading-relaxed text-emerald-300">
            {view.receiveApr !== null && view.payApr !== null ? (
              <>
                receive <span className="num">{fmtPct(view.receiveApr)}</span> − pay{' '}
                <span className="num">{fmtPct(view.payApr)}</span> ≈{' '}
                <span className="num font-semibold">{fmtPct(view.lockedSpread)}</span> locked until
                maturity
              </>
            ) : (
              <>
                <span className="num font-semibold">{fmtPct(view.lockedSpread)}</span> locked until
                maturity
              </>
            )}
          </div>
        </LayerBox>
      </div>
    </section>
  );
}
