import { useEffect, useState } from 'react';
import { SETUP_STEPS, useSetupState, type SetupStep } from './setupState';
import { SetupRows } from './SetupRows';

export function SetupPage({ onFinish }: { onFinish: () => void }) {
  const { steps, firstMissing, isLoading } = useSetupState();
  const [openStep, setOpenStep] = useState<SetupStep | null | undefined>(undefined);

  useEffect(() => {
    if (!isLoading && openStep === undefined) setOpenStep(firstMissing);
  }, [isLoading, openStep, firstMissing]);

  const advance = (from: SetupStep) => {
    const next = SETUP_STEPS.slice(SETUP_STEPS.indexOf(from) + 1).find((step) => steps[step] === 'missing');
    if (next) {
      setOpenStep(next);
      return;
    }
    onFinish();
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-10">
      <h1 className="text-base font-semibold text-ink-50">Set up the terminal</h1>
      <SetupRows openStep={openStep} onOpenStep={setOpenStep} onDone={advance} variant="setup" />
    </div>
  );
}
