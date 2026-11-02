/**
 * The roll-over banner, app-wide.
 *
 * It used to live inside the ETH asset card, which meant a trader on
 * Opportunities or Balances never learned a hedge was about to settle. It now
 * sits under the navbar on every tab, beside the recovery banner, and reads
 * whatever the asset cards published (see rollSignal.tsx).
 *
 * Two tones, as before: QUIET while the window is merely open (14d to 7d
 * out), LOUD once a pair is a week from settling or a better rate is on
 * offer. Beside it, one pill that explains what a roll is and when to do it —
 * the numbers mean nothing to someone who has not met the mechanic (his call
 * 2026-09-20).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { daysToMaturity } from '../lib/boros';
import { fmtDateLocal, fmtPct, prettyVenue } from '../lib/fmt';
import { EXPIRY_WARN_DAYS } from './assets/assetModel';
import { useRollSignalsOptional, type RollSignal } from './rollSignal';

/** A pair this close to maturing makes the banner loud on its own. */
const ROLL_URGENT_DAYS = 7;
/** How many reasons the bar names before it folds the rest into "+N more".
 * Two is what fits beside the controls at a laptop width without wrapping
 * the bar to a second line (his call 2026-09-20). */
const MAX_REASONS = 2;

const daysTo = daysToMaturity;

export function RollOverBanner({ onShowPositions }: { onShowPositions: () => void }) {
  const { t } = useTranslation();
  const api = useRollSignalsOptional();
  const [guideOpen, setGuideOpen] = useState(false);
  const signals = api?.signals ?? [];
  if (signals.length === 0) return null;
  const nowSec = Math.floor(Date.now() / 1000);

  type Reason = { key: string; node: React.ReactNode; plain: string };
  const reason = (s: RollSignal): Reason | null => {
    const name = `${prettyVenue(s.longVenue)} / ${prettyVenue(s.shortVenue)}`;
    if (s.opportunity) {
      const o = s.opportunity;
      const values = {
        asset: s.asset,
        name,
        rate: fmtPct(o.rate),
        days: daysTo(o.maturity, nowSec),
        current: fmtPct(o.current),
        currentDays: daysTo(o.currentMaturity, nowSec),
      };
      return {
        key: s.key,
        plain: t('opportunities.roll.betterPlain', values),
        node: (
          <Trans
            i18nKey="opportunities.roll.better"
            values={values}
            components={{
              a: <span className="text-ink-300" />,
              r: <span className="font-semibold text-emerald-300" />,
              m: <span className="text-ink-200" />,
            }}
          />
        ),
      };
    }
    const days = daysTo(s.maturity, nowSec);
    return days <= ROLL_URGENT_DAYS
      ? {
          key: s.key,
          plain: t('opportunities.roll.maturesPlain', { asset: s.asset, name, days }),
          node: (
            <Trans
              i18nKey="opportunities.roll.matures"
              values={{ asset: s.asset, name, days }}
              components={{ a: <span className="text-ink-300" /> }}
            />
          ),
        }
      : null;
  };
  const reasons = signals.map(reason).filter((r): r is Reason => r !== null);
  const loud = reasons.length > 0;
  // The rest are named in the hover, never dropped silently.
  const shown = reasons.slice(0, MAX_REASONS);
  const extra = reasons.length - shown.length;

  return (
    <div
      data-tone={loud ? 'loud' : 'quiet'}
      className={`border-b ${loud ? 'border-emerald-400/50 bg-emerald-500/10' : 'border-ink-800 bg-ink-950/60'}`}
    >
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-2">
        <button
          type="button"
          className={`flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1.5 rounded text-left transition-colors ${
            loud ? 'text-[13px] text-ink-50 hover:text-white' : 'text-xs text-ink-400 hover:text-ink-200'
          }`}
          title={signals
            .map((s) =>
              t('opportunities.roll.bannerTitle', {
                asset: s.asset,
                pair: `${prettyVenue(s.longVenue)}/${prettyVenue(s.shortVenue)}`,
                date: fmtDateLocal(s.maturity),
              }),
            )
            .join(' · ')}
          onClick={() => {
            // Both: switch to Positions, and ask the cards there to open the
            // rollable pairs and scroll the first one into view.
            onShowPositions();
            api?.requestShow();
          }}
        >
          {loud ? (
            <>
              <span className="font-semibold">{t('opportunities.roll.rollNow')}</span>
              <span aria-hidden className="h-4 w-px bg-emerald-400/40" />
              {shown.map((r) => (
                <span key={r.key} className="num rounded border border-emerald-400/30 bg-emerald-400/[0.07] px-2 py-0.5 text-[12px] text-ink-100">
                  {r.node}
                </span>
              ))}
              {extra > 0 && (
                <span
                  className="num rounded border border-emerald-400/20 px-2 py-0.5 text-[12px] text-ink-300"
                  title={reasons.slice(MAX_REASONS).map((r) => r.plain).join('\n')}
                >
                  {t('opportunities.roll.more', { n: extra })}
                </span>
              )}
            </>
          ) : (
            <span className="font-medium">
              {t('opportunities.roll.due', { count: signals.length })}
            </span>
          )}
        </button>
        <RollGuidePill open={guideOpen} onOpenChange={setGuideOpen} loud={loud} />
        <button
          type="button"
          className={`shrink-0 whitespace-nowrap text-xs ${loud ? 'text-ink-100 hover:text-white' : 'text-ink-500 hover:text-ink-300'}`}
          onClick={() => {
            onShowPositions();
            api?.requestShow();
          }}
        >
          {t('opportunities.roll.showMe')}
        </button>
      </div>
    </div>
  );
}

/**
 * "Explain rollover to me" — hover or click.
 *
 * Hover for the reader already scanning the banner, click for the one who
 * wants it to stay put; Escape and an outside click close it. Deliberately
 * not a modal: it explains the thing next to it, and a modal would take the
 * banner off screen while it did.
 */
function RollGuidePill({
  open,
  onOpenChange,
  loud,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  loud: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [hover, setHover] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const shown = open || hover;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, onOpenChange]);

  return (
    <div
      ref={wrap}
      className="relative shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        className={`whitespace-nowrap rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
          loud
            ? 'border-emerald-400/40 text-emerald-100 hover:border-emerald-300 hover:bg-emerald-400/10'
            : 'border-ink-700 text-ink-400 hover:border-ink-500 hover:text-ink-200'
        }`}
        onClick={() => onOpenChange(!open)}
      >
        {t('opportunities.roll.explain')}
      </button>
      {shown && (
        <div
          id={id}
          role="note"
          aria-label={t('opportunities.roll.guideAria')}
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[420px] max-w-[calc(100vw-40px)] rounded-lg border border-ink-600 bg-ink-950 p-4 text-[12px] leading-relaxed text-ink-200 shadow-xl"
        >
          <p className="mb-2.5 text-[13px] font-semibold text-ink-50">{t('opportunities.roll.guideTitle')}</p>
          <p className="mb-2.5">
            <Trans i18nKey="opportunities.roll.guideLocked" components={{ hi: <span className="text-ink-50" /> }} />
          </p>
          <p className="mb-3">
            <Trans
              i18nKey="opportunities.roll.guideEdge"
              components={{ hi: <span className="text-ink-50" />, g: <span className="text-emerald-300" /> }}
            />
          </p>
          <p className="mb-1.5 text-[12.5px] font-semibold text-ink-50">{t('opportunities.roll.whenTitle')}</p>
          <ul className="flex list-disc flex-col gap-1.5 pl-4">
            <li>
              <Trans
                i18nKey="opportunities.roll.whenLastDays"
                values={{ days: EXPIRY_WARN_DAYS }}
                components={{ hi: <span className="text-ink-50" />, g: <span className="text-emerald-300" /> }}
              />
            </li>
            <li>
              <Trans i18nKey="opportunities.roll.whenPaysMore" components={{ hi: <span className="text-ink-50" /> }} />
            </li>
            <li>
              <Trans i18nKey="opportunities.roll.whenMatures" components={{ hi: <span className="text-ink-50" /> }} />
            </li>
          </ul>
          <p className="mt-3 text-ink-400">{t('opportunities.roll.notRolling')}</p>
        </div>
      )}
    </div>
  );
}
