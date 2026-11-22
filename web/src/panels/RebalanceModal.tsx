import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useRebalance, useRebalanceCommand, useTransfer } from '../api/queries';
import type { GateAccount, RebalanceJob, RebalanceView, TransferCoin } from '../api/types';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { UnderlineTabs } from '../components/UnderlineTabs';
import { apiErrorText } from '../lib/apiErrorText';
import { useNow } from '../lib/useNow';
import { DeleverTab } from './DeleverTab';
import { MoveCashTab } from './MoveCashTab';
import { RealizeTab } from './RealizeTab';
import { JobChip, RebalanceJobView } from './RebalanceJobView';
import { useRebalanceOpenState, useTransferPick, type RebalanceTab } from './rebalanceOpener';

const TABS: readonly RebalanceTab[] = ['move', 'realize', 'delever'];

export function initialTab(view: RebalanceView): RebalanceTab {
  return view.fullPlan?.needsRealize ? 'realize' : 'move';
}

const jobTab = (job: RebalanceJob): RebalanceTab => job.kind ?? 'move';

const isLive = (job: RebalanceJob | null): boolean =>
  job?.status === 'running' ||
  job?.status === 'halted' ||
  (job?.status === 'abandoned' && job.kind === 'delever' && (job.borosGapYu ?? 0) > 0);

export function RebalanceModal({
  view,
  onClose,
  holdMs,
  tab: openTab = null,
  pairKey = null,
  onTransfer,
}: {
  view: RebalanceView;
  onClose: () => void;
  holdMs?: number;
  tab?: RebalanceTab | null;
  pairKey?: string | null;
  onTransfer?: (coin: TransferCoin, wallet: GateAccount) => void;
}) {
  const { t } = useTranslation();
  const transfer = useTransfer().data;
  const resume = useRebalanceCommand('resume');
  const abandon = useRebalanceCommand('abandon');
  const toast = useToast();
  const now = useNow();
  const { job } = view;
  const live = isLive(job);
  const [tab, setTab] = useState<RebalanceTab>(() => (job !== null && isLive(job) ? jobTab(job) : (openTab ?? initialTab(view))));
  const [sawRun, setSawRun] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (live) setSawRun(true);
  }, [job?.id, job?.status]);

  const shown = job !== null && (live || (job.status === 'done' && (sawRun || started)));
  const lock = live ? t('accounts.rebalanceTabs.wait') : null;
  const onStarted = () => setStarted(true);

  const onError = (error: Error) => toast.push('error', apiErrorText(error));

  let body: ReactNode;
  if (shown && jobTab(job) === tab) {
    body = (
      <RebalanceJobView
        job={job} view={view} now={now} holdMs={holdMs} transfer={transfer} onClose={onClose} onTransfer={onTransfer} onTab={setTab}
        busy={resume.isPending || abandon.isPending}
        resuming={resume.isPending}
        onResume={() => resume.mutate(job.id, { onError })}
        onAbandon={() => abandon.mutate(job.id, { onError })}
      />
    );
  } else if (tab === 'move') {
    body = <MoveCashTab view={view} holdMs={holdMs} lock={lock} onTab={setTab} onStarted={onStarted} onTransfer={onTransfer} />;
  } else if (tab === 'realize') {
    body = <RealizeTab view={view} holdMs={holdMs} lock={lock} onTab={setTab} onStarted={onStarted} />;
  } else {
    body = <DeleverTab key={pairKey ?? ''} pairKey={pairKey} holdMs={holdMs} lock={lock} onStarted={onStarted} />;
  }

  return (
    <Modal
      widthClass="w-[680px]"
      onClose={onClose}
      title={
        <span className="flex items-end gap-3">
          <UnderlineTabs<RebalanceTab>
            ariaLabel={t('accounts.borrowCard.reduce')}
            look="underline"
            value={tab}
            onChange={setTab}
            options={TABS.map((value) => ({ value, label: t(`accounts.rebalanceTabs.${value}`) }))}
          />
          {shown && <span className="pb-2.5"><JobChip job={job} /></span>}
        </span>
      }
    >
      <div className="flex flex-col gap-4">{body}</div>
    </Modal>
  );
}

function OpenRebalanceModal({ tab, pairKey, holdMs, onClose }: { tab: RebalanceTab | null; pairKey: string | null; holdMs?: number; onClose: () => void }) {
  const view = useRebalance().data;
  const pickTransfer = useTransferPick();
  if (!view) return null;
  return (
    <RebalanceModal
      view={view}
      tab={tab}
      pairKey={pairKey}
      holdMs={holdMs}
      onClose={onClose}
      onTransfer={(coin, wallet) => {
        onClose();
        pickTransfer(coin, wallet);
      }}
    />
  );
}

export function RebalanceModalHost({ holdMs }: { holdMs?: number }) {
  const { open, tab, pairKey, close } = useRebalanceOpenState();
  if (!open) return null;
  return <OpenRebalanceModal key={`${tab ?? ''}:${pairKey ?? ''}`} tab={tab} pairKey={pairKey} holdMs={holdMs} onClose={close} />;
}
