import { SETUP_STEPS } from '../panels/setup/setupState';

export function FinishSetupPill({ doneCount, onOpen }: { doneCount: number; onOpen: () => void }) {
  if (doneCount >= SETUP_STEPS.length) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="hdr-ctl border-amber-500/40 bg-amber-500/10 font-medium text-amber-400 hover:bg-amber-500/20"
    >
      Finish setup{' '}
      <span className="num">
        {doneCount}/{SETUP_STEPS.length}
      </span>
    </button>
  );
}
