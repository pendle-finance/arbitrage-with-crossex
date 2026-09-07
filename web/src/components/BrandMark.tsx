import { BorosLogo } from './BorosLogo';

/** The product identity block shared by the terminal header and the public
 * landing header — one source so the two can't drift.
 *
 * Mock order: Boros mark → divider → "Arbitrage with CrossEx". */
export function BrandMark() {
  return (
    <>
      <BorosLogo className="block h-[18px] w-auto shrink-0" />
      <span aria-hidden="true" className="h-[18px] w-px shrink-0 bg-ink-600" />
      {/* Two-tone wordmark: the leading "Arbitrage" carries the accent, the
       * rest stays neutral. Mirrored on the canvas share card
       * (lib/shareCard.ts) — keep the two in step. */}
      <h1 className="flex items-baseline gap-1.5 whitespace-nowrap text-[13px] font-semibold tracking-tight text-ink-50">
        <span className="text-pastel-blue">Arbitrage</span>
        with CrossEx
      </h1>
      {/* The live-data pill that used to sit here is gone: the header already
       * carries a freshness indicator ("7s ago"), and two claims about the same
       * thing meant the static one kept asserting "live" while the real clock
       * was the one next to it. */}
    </>
  );
}
