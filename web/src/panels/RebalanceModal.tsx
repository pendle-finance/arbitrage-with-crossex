import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useRebalance, useRebalanceCommand, useTransfer } from '../api/queries';
import type { GateAccount, RebalanceJob, RebalanceView, TransferCoin } from '../api/types';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { UnderlineTabs } from '../components/UnderlineTabs';
import { apiErrorText } from '../lib/apiErrorText';
import { readJson, writeJson } from '../lib/storage';
import { useNow } from '../lib/useNow';
import { DeleverTab } from './DeleverTab';
import { MoveCashTab } from './MoveCashTab';
import { RealizeTab } from './RealizeTab';
import { isTwapRun, JobChip, RebalanceJobView } from './RebalanceJobView';
import { useRebalanceOpenState, useTransferPick, type RebalanceTab } from './rebalanceOpener';

const TABS: readonly RebalanceTab[] = ['move', 'realize', 'delever'];

export function initialTab(view: RebalanceView): RebalanceTab {
  return view.fullPlan?.needsRealize ? 'realize' : 'move';
}

const jobTab = (job: RebalanceJob): RebalanceTab => (job.kind === 'twap' ? 'move' : (job.kind ?? 'move'));

const RESULT_SEEN_KEY = 'crossex.twapResultSeen.v1';

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
  const twapRun = job !== null && isTwapRun(job);
  const ended = job !== null && (job.status === 'done' || (twapRun && job.status === 'abandoned'));
  const [seenResult] = useState(() => readJson<string | null>(RESULT_SEEN_KEY, null, (v) => (typeof v === 'string' ? v : null)));
  const unseenResult = twapRun && ended && seenResult !== job.id;
  const [tab, setTab] = useState<RebalanceTab>(() => (job !== null && (live || unseenResult) ? jobTab(job) : (openTab ?? initialTab(view))));
  const [sawRun, setSawRun] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (live) setSawRun(true);
  }, [job?.id, job?.status]);

  const shown = job !== null && (live || (ended && (sawRun || started || unseenResult)));

  useEffect(() => {
    if (shown && twapRun && ended) writeJson(RESULT_SEEN_KEY, job.id);
  }, [shown, twapRun, ended, job?.id]);
  const lock = job?.status === 'running' || job?.status === 'halted' ? t('accounts.rebalanceTabs.wait') : null;
  const onStarted = () => setStarted(true);

  const onError = (error: Error) => toast.push('error', apiErrorText(error));

  let body: ReactNode;
  if (shown && (job.kind === 'twap' || jobTab(job) === tab)) {
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
      tabbed={!(shown && job.kind === 'twap')}
      onClose={onClose}
      title={
        shown && job.kind === 'twap' ? null : (
        <span className="flex h-full items-stretch gap-3">
          <UnderlineTabs<RebalanceTab>
            ariaLabel={t('accounts.borrowCard.reduce')}
            look="glow"
            className="flex-1"
            value={tab}
            onChange={setTab}
            options={TABS.map((value) => ({
              value,
              label: t(`accounts.rebalanceTabs.${value}`),
              badge: shown && jobTab(job) === value ? <JobChip job={job} /> : undefined,
            }))}
          />
        </span>
        )
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
