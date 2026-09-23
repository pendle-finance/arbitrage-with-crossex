import { Chip } from './Chip';

export function ViewOnlyChip() {
  return (
    <Chip sm tone="neutral" className="inline-flex items-center gap-1">
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      View only
    </Chip>
  );
}
