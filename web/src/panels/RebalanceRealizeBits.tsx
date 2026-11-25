import { fmtUsd } from '../lib/fmt';
import { MODAL_FEE, MODAL_IMPACT } from './rebalanceCopy';

export function FeeCell({ feeUsd, impactUsd }: { feeUsd: number; impactUsd: number }) {
  return (
    <span className="num text-right text-ink-100">
      {MODAL_FEE(fmtUsd(feeUsd))}
      {impactUsd > 0 && <span className="block text-[11px] text-ink-400">{MODAL_IMPACT(fmtUsd(impactUsd))}</span>}
    </span>
  );
}
