import { Chip } from './Chip';

/** The product identity block shared by the terminal header and the public
 * landing header — one source so the two can't drift. */
export function BrandMark() {
  return (
    <>
      <h1 className="flex items-baseline gap-2 text-base font-semibold tracking-tight text-ink-100">
        CrossEx-Boros
        <span className="font-mono text-xs font-medium uppercase tracking-widest text-cyan-400">
          Terminal
        </span>
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
