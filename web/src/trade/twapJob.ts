import type { RebalanceJob } from '../api/types';

const CHILD_SUFFIX = /^(s[1-9]\d*-[1-9]\d*|f[1-9]\d*)$/;

export function liveTwapJob(job: RebalanceJob | null | undefined): RebalanceJob | null {
  if (!job || job.kind !== 'twap' || !job.twap) return null;
  return job.status === 'running' || job.status === 'halted' ? job : null;
}

export function isTwapChildId(id: string, jobId: string): boolean {
  return jobId !== '' && id.startsWith(`${jobId}-`) && CHILD_SUFFIX.test(id.slice(jobId.length + 1));
}
