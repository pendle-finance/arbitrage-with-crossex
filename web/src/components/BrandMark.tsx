import { Chip } from './Chip';

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
      <div className="flex items-center gap-2">
        <Chip sm tone="blue" title="Free and open source — audit or contribute on GitHub">
          Open source tool
        </Chip>
        <Chip sm tone="amber" title="Experimental software trading real funds — use at your own risks">
          Experimental, use at your own risks
        </Chip>
      </div>
    </>
  );
}
