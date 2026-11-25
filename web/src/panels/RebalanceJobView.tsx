import type { RebalanceJob } from '../api/types';
import { Chip } from '../components/Chip';
import { t } from '../i18n';
import { RunView, twapRunProps } from '../trade/RunView';
import type { JobViewProps } from './RebalanceJobBits';
import { MoveJobView } from './RebalanceMoveJobView';
import { isSliceJob, SliceJobView } from './RebalanceSliceJobView';

const isTwapRun = (job: RebalanceJob): boolean =>
  job.kind === 'twap' || (job.kind === 'delever' && job.twap != null);

export function RebalanceJobView(props: JobViewProps) {
  if (isTwapRun(props.job)) return <RunView {...twapRunProps(props.job, props.now)} />;
  if (isSliceJob(props.job)) return <SliceJobView {...props} />;
  return <MoveJobView {...props} />;
}

export function JobChip({ job }: { job: RebalanceJob }) {
  if (job.status === 'running') return <Chip tone="info">{t('common.running')}</Chip>;
  if (job.status === 'done') return <Chip>{t('accounts.sliceRun.done')}</Chip>;
  const notHedged = (job.notHedgedQty ?? 0) > 0 || (job.borosLeftYu ?? 0) > 0 || (job.borosGapYu ?? 0) > 0;
  if (job.status === 'halted' && job.paused === true) return <Chip tone={notHedged ? 'red' : 'amber'}>{t('accounts.sliceRun.chipPaused')}</Chip>;
  return <Chip tone="red">{t(notHedged ? 'accounts.sliceRun.chipNotHedged' : 'common.stopped')}</Chip>;
}
