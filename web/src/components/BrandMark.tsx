/** The product identity block shared by the terminal header and the public
 * landing header — one source so the two can't drift. */
export function BrandMark() {
  return (
    <>
      {/* Two-tone wordmark: the leading "Arbitrage" carries the cyan accent, the
       * rest stays neutral. Mirrored on the canvas share card (lib/shareCard.ts)
       * — keep the two in step. */}
      <h1 className="flex items-baseline gap-1.5 text-base font-semibold tracking-tight text-ink-100">
        <span className="text-cyan-400">Arbitrage</span>
        with CrossEx
      </h1>
      {/* A live-data indicator rather than the two chips this replaced ("Open
       * source tool" / "Experimental, use at your own risks"). The risk warning
       * is not lost with them: DisclaimerGate states it in full and makes the
       * user accept it before the terminal opens, which is where a disclosure
       * that matters belongs — a chip beside the wordmark is read once and then
       * never again. */}
      <span
        className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-400"
        title="Rates, books and positions are polled live from the venues"
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </span>
        Live market data
      </span>
    </>
  );
}
