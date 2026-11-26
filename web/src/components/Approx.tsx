import { EqualApproximately } from 'lucide-react';
import { Trans } from 'react-i18next';
import type { RealizeExec } from '../api/types';
import { t } from '../i18n';
import { fmtApprox } from '../lib/fmt';
import { execModeKey } from '../panels/rebalanceCopy';

export function ApproxMark() {
  return (
    <>
      <EqualApproximately size={12} aria-hidden className="mr-0.5 inline-block align-[-1px]" />
      <span className="sr-only">{t('app.approx.mark')} </span>
    </>
  );
}

export function ExecModeLabel({ mode, usd, seconds, whole }: { mode: RealizeExec; usd: string; seconds: number | null; whole: boolean }) {
  return (
    <Trans
      i18nKey={execModeKey(mode, whole)}
      values={{ usd, time: seconds === null ? '—' : fmtApprox(seconds) }}
      components={{ approx: <ApproxMark /> }}
    />
  );
}

export function ApproxTime({ seconds }: { seconds: number }) {
  return (
    <span className="whitespace-nowrap">
      <ApproxMark />
      {fmtApprox(seconds)}
    </span>
  );
}
