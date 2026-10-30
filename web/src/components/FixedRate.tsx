import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { fmtPct, signedClass } from '../lib/fmt';

/** A locked Boros rate as a trader reads it: "pay 8.74%" or "receive 7.12%".
 * `apr` is signed by the cash flow, receive + and pay − — the sign
 * `PairLegDetail.lockedApr` and the bundle's fixed rate already carry. One
 * wording on every screen that shows a locked rate. */
export function FixedRate({ apr }: { apr: number }) {
  const { t } = useTranslation();
  return <span className={`num ${signedClass(apr)}`}>{fixedRateText(t, apr)}</span>;
}

/** The same words as plain text, for a line that runs on past the rate. */
export const fixedRateText = (t: TFunction, apr: number): string =>
  // −0 is a long entered at 0%: it pays.
  t(apr > 0 || Object.is(apr, 0) ? 'common.receiveRate' : 'common.payRate', { rate: fmtPct(Math.abs(apr)) });
