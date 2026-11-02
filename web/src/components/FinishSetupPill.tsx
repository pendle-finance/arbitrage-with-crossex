import { useTranslation } from 'react-i18next';
import { SETUP_STEPS } from '../panels/setup/setupState';

export function FinishSetupPill({ doneCount, onOpen }: { doneCount: number; onOpen: () => void }) {
  const { t } = useTranslation();
  if (doneCount >= SETUP_STEPS.length) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="hdr-ctl gap-1 border-amber-500/40 bg-amber-500/10 font-medium text-amber-400 hover:bg-amber-500/20"
    >
      {t('app.finishSetup')}{' '}
      <span className="num">
        {doneCount}/{SETUP_STEPS.length}
      </span>
    </button>
  );
}
