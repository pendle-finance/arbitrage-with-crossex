/** Deal recovery banner. Two cases:
 *  - a deal STILL WORKING after a tab reload — the modal was lost with the page
 *    and the user needs a way back into the live view (shown first: real orders
 *    are moving server-side).
 *  - standing engine ALERTS (hedge walls, quarantined orders, halted deals) —
 *    rendered until acked; the engine keeps retrying underneath. */
import { useTranslation } from 'react-i18next';
import { Pause, TriangleAlert } from 'lucide-react';
import { useAckAlert, useActiveDeals, useAlerts, useRebalance } from '../api/queries';
import type { RebalanceJob } from '../api/types';
import { Spinner } from '../components/Spinner';
import { parseSymbol, prettyVenue } from '../lib/fmt';
import { useRebalanceOpener } from '../panels/rebalanceOpener';
import { useTradeFlow } from './TradeFlow';
import { isTwapChildId, liveTwapJob } from './twapJob';
import { localizeServerText } from '../i18n/serverMessages';

type StripKey = 'running' | 'paused' | 'restart' | 'sleep' | 'refused' | 'hedge' | 'error' | 'capped' | 'boros';
type StripTone = 'cyan' | 'amber' | 'rose';

const STRIP_TONES: Record<StripTone, { box: string; text: string; button: string }> = {
  cyan: { box: 'border-cyan-500/30 bg-cyan-500/10', text: 'text-cyan-200', button: 'border-cyan-500/50 text-cyan-300' },
  amber: { box: 'border-amber-500/30 bg-amber-500/10', text: 'text-amber-200', button: 'border-amber-500/50 text-amber-300' },
  rose: { box: 'border-rose-500/40 bg-rose-500/10', text: 'text-rose-200', button: 'border-rose-500/50 text-rose-300' },
};

function stripKeyOf(job: RebalanceJob): StripKey {
  if (job.status === 'running') return job.paused ? 'paused' : 'running';
  switch (job.haltKind) {
    case 'restart':
      return 'restart';
    case 'sleep':
      return 'sleep';
    case 'refused':
      return 'refused';
    case 'hedge-margin':
      return 'hedge';
    case 'capped-rest':
      return 'capped';
    case 'boros':
      return 'boros';
    case null:
    case undefined:
      return 'paused';
    default:
      return 'error';
  }
}

function stripToneOf(key: StripKey): StripTone {
  if (key === 'running') return 'cyan';
  if (key === 'paused' || key === 'restart' || key === 'sleep') return 'amber';
  return 'rose';
}

function TwapStrip({ job }: { job: RebalanceJob }) {
  const { t } = useTranslation();
  const open = useRebalanceOpener();
  const twap = job.twap!;
  const key = stripKeyOf(job);
  const tone = STRIP_TONES[stripToneOf(key)];
  const coin = job.legs?.[0] ? parseSymbol(job.legs[0].name).base || job.legs[0].name : '';
  const refusedLeg = job.legs?.[twap.makerLeg === 'a' ? 0 : 1];
  const venue = refusedLeg ? prettyVenue(refusedLeg.exchange.toLowerCase()) : '';
  const icon =
    key === 'running' ? (
      <Spinner className="h-3 w-3" />
    ) : stripToneOf(key) === 'rose' ? (
      <TriangleAlert size={12} aria-hidden />
    ) : (
      <Pause size={12} aria-hidden />
    );
  return (
    <div role="alert" className={`border-b ${tone.box}`}>
      <div className={`mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-5 py-2 text-xs ${tone.text}`}>
        <span className="inline-flex items-center gap-2">
          {icon}
          <span className="num">{t(`trade.twap.strip.${key}`, { coin, i: twap.slice, n: twap.of, venue })}</span>
        </span>
        <button type="button" className={`btn-ghost-xs ${tone.button}`} onClick={() => open()}>
          {t('trade.recovery.view')}
        </button>
      </div>
    </div>
  );
}

export function RecoveryBanner({ onOpenTab }: { onOpenTab?: (tab: 'balances') => void }) {
  const { t } = useTranslation();
  const flow = useTradeFlow();
  const active = useActiveDeals();
  const alerts = useAlerts();
  const ack = useAckAlert();
  const twapJob = liveTwapJob(useRebalance().data?.job);

  // A single resting limit order (no hedge leg, no deadline) is a plain order,
  // not a deal in flight — it lives in Open Orders and needs no supervision.
  // Nagging about it here is what made placing one feel like starting a process.
  // Anything that has actually gone wrong still surfaces through `standing`.
  const deals = (active.data ?? []).filter(
    (d) =>
      !(d.pair.b === null && d.pair.limitPrice !== null && d.pair.mode === 'OPENING') &&
      !(twapJob && isTwapChildId(d.pair.id, twapJob.id)),
  );
  const standing = alerts.data ?? [];

  if (twapJob) return <TwapStrip job={twapJob} />;

  if (!flow.modalOpen && deals.length > 0) {
    const newest = [...deals].sort((a, b) => b.pair.createdAt - a.pair.createdAt)[0];
    const halted = deals.filter((d) => d.pair.mode === 'HALTED').length;
    return (
      <div
        role="alert"
        className={`border-b ${halted ? 'border-rose-500/40 bg-rose-500/10' : 'border-cyan-500/30 bg-cyan-500/10'}`}
      >
        <div
          className={`mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-5 py-2 text-xs ${halted ? 'text-rose-200' : 'text-cyan-200'}`}
        >
          <span className="inline-flex items-center gap-2">
            <Spinner className="h-3 w-3" />
            {halted
              ? t('trade.recovery.halted', { count: halted })
              : deals.length > 1
                ? t('trade.recovery.workingMore', { count: deals.length - 1 })
                : t('trade.recovery.working')}
          </span>
          <button
            type="button"
            className={`btn-ghost-xs ${halted ? 'border-rose-500/50 text-rose-300' : 'border-cyan-500/50 text-cyan-300'}`}
            onClick={() => flow.openDeal((deals.find((d) => d.pair.mode === 'HALTED') ?? newest).pair.id)}
          >
            {t('trade.recovery.view')}
          </button>
        </div>
      </div>
    );
  }

  if (standing.length === 0) return null;
  const alert = standing[0];
  const isRebalance = alert.pairId?.startsWith('rebalance:') ?? false;
  return (
    <div role="alert" className="border-b border-amber-500/30 bg-amber-500/10">
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-5 py-2 text-xs text-amber-200">
        <span>
          {localizeServerText(alert.message)}
          {standing.length > 1 ? t('trade.recovery.more', { count: standing.length - 1 }) : ''}
        </span>
        {isRebalance
          ? onOpenTab && (
              <button
                type="button"
                className="btn-ghost-xs border-amber-500/50 text-amber-300"
                onClick={() => onOpenTab('balances')}
              >
                {t('trade.recovery.view')}
              </button>
            )
          : alert.pairId && (
              <button
                type="button"
                className="btn-ghost-xs border-amber-500/50 text-amber-300"
                onClick={() => flow.openDeal(alert.pairId!)}
              >
                {t('trade.recovery.view')}
              </button>
            )}
        <button type="button" className="btn-ghost-xs" onClick={() => ack.mutate(alert.id)}>
          {t('common.dismiss')}
        </button>
      </div>
    </div>
  );
}
