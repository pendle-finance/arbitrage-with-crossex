/** The viewer's "At maturity" choice — rendered twice (hero + the PnL
 * section), both driving the same PositionApp state, so the two can never
 * disagree. The sharer's own assumption is marked "(as shared)". */
import { SegmentedToggle } from '../components/SegmentedToggle';
import { microLabelClass } from '../components/Th';
import type { ExitMode } from './derive';

export function ExitModeToggle({
  exitMode,
  sharedMode,
  onChange,
  hideLabelOnPhone = false,
}: {
  exitMode: ExitMode;
  sharedMode: ExitMode;
  onChange: (next: ExitMode) => void;
  /** For tight header rows: the micro label yields on phones so the cluster's
   * min-width never forces a horizontal page scroll (aria-label remains). */
  hideLabelOnPhone?: boolean;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className={`${microLabelClass}${hideLabelOnPhone ? ' max-sm:hidden' : ''}`}>
        At maturity
      </span>
      <SegmentedToggle<ExitMode>
        ariaLabel="At maturity"
        value={exitMode}
        onChange={onChange}
        options={[
          { value: 'roll', label: 'Roll over', sub: sharedMode === 'roll' ? '(as shared)' : undefined },
          { value: 'close', label: 'Close perps', sub: sharedMode === 'close' ? '(as shared)' : undefined },
        ]}
      />
    </span>
  );
}
