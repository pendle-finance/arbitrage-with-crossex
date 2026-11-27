import type { ReactNode } from 'react';
import type { EvenPlan, GateAccount, RebalanceJob, RebalanceView, RoutePlan, TransferCoin, TransferView } from '../api/types';
import { HoldToConfirmButton } from '../components/HoldToConfirmButton';
import { ResultBox, type ResultRow } from '../components/ResultBox';
import { t } from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { num } from '../lib/fmt';
import { HOVER, modalResume } from './rebalanceCopy';
import { roundCountOf, roundOf } from './RebalanceHovers';
import type { RebalanceTab } from './rebalanceOpener';
import { realizeText } from './RebalancePlanBits';

export interface Pressed {
  view: RebalanceView;
  plan: EvenPlan;
  route: RoutePlan;
}

export interface JobViewProps {
  job: RebalanceJob;
  view: RebalanceView;
  now: number;
  onResume: () => void;
  onAbandon: () => void;
  holdMs?: number;
  pressed?: Pressed | null;
  busy?: boolean;
  resuming?: boolean;
  transfer?: TransferView;
  onClose?: () => void;
  onTransfer?: (coin: TransferCoin, wallet: GateAccount) => void;
  onTab?: (tab: RebalanceTab) => void;
}

export function abandonNote(job: RebalanceJob, transfer: TransferView | undefined): string {
  const transit = job.inTransit;
  if (!transit) return HOVER.abandon;
  const values = { qty: num(transit.qty), coin: transit.coin };
  if (transit.at !== 'SPOT') return t('accounts.rebalanceModal.abandonTransit', values);
  return t(transfer?.spot === null ? 'accounts.rebalanceModal.abandonSpotNoRead' : 'accounts.rebalanceModal.abandonSpot', values);
}

export const haltLine = (reason: string | null): string[] => (reason ? [localizeServerText(reason)] : []);

const GAP_SENTENCE = /(?<=^|\. )(The )?\S+ (long|short) is \S+ \S+ smaller than (the \S+ (long|short)|before)\.( |$)/g;

export const gapBoxLines = (reason: string | null): string[] => {
  const rest = reason?.replace(GAP_SENTENCE, '').trim();
  return rest ? localizeServerText(rest).split(/(?<=\.)\s+(?=[A-Z])|(?<=。)(?=\S)/) : [];
};

export function stopTitle(job: RebalanceJob): string {
  const round = roundOf(job);
  return round === null
    ? t('accounts.rebalanceModal.stoppedAtConvert')
    : t('accounts.rebalanceModal.stoppedInRound', { round: num(round, 0), rounds: num(roundCountOf(job), 0) });
}

export function StopBox({ title, lines, rows }: { title: ReactNode; lines: ReactNode[]; rows?: ResultRow[] }) {
  return <ResultBox tone="stop" title={title} lines={lines} rows={rows} />;
}

export function Actions({
  onResume, onAbandon, holdMs, busy, resuming, note, resumeLabel, abandonLabel, quietResume,
}: JobViewProps & { note: string; resumeLabel?: string; abandonLabel?: string; quietResume?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {note && <span className="num text-xs text-ink-400">{note}</span>}
      <div className="flex gap-2">
        <button type="button" className={`btn ${quietResume ? '' : 'btn-primary'} flex-1`} disabled={busy} onClick={onResume}>
          {resuming ? t('accounts.rebalanceModal.resuming') : (resumeLabel ?? modalResume())}
        </button>
        <HoldToConfirmButton tone="outline" compact className="flex-1" holdMs={holdMs} disabled={busy} onConfirm={onAbandon}>
          {abandonLabel ?? realizeText('holdAbandon')}
        </HoldToConfirmButton>
      </div>
    </div>
  );
}

