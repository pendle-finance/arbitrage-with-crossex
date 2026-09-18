import { BorosWalletRow } from './BorosWalletRow';
import { GateKeyRow } from './GateKeyRow';
import type { SetupRowProps, SetupStep } from './setupState';
import { TelegramRow } from './TelegramRow';

export function SetupRows({
  openStep,
  onOpenStep,
  onDone,
  variant,
  onOpenGuide,
}: {
  openStep: SetupStep | null | undefined;
  onOpenStep: (step: SetupStep | null) => void;
  onDone: (step: SetupStep) => void;
  variant: SetupRowProps['variant'];
  onOpenGuide?: () => void;
}) {
  const rowProps = (step: SetupStep): SetupRowProps => ({
    open: openStep === step,
    onOpen: () => onOpenStep(step),
    onClose: () => onOpenStep(null),
    onDone: () => onDone(step),
    onSkip: variant === 'setup' && step !== 'gateKey' ? () => onDone(step) : undefined,
    variant,
  });

  return (
    <div
      className={`flex flex-col divide-y divide-ink-800 rounded-lg border border-ink-700 ${variant === 'setup' ? 'bg-ink-900' : ''}`}
    >
      <GateKeyRow {...rowProps('gateKey')} onOpenGuide={onOpenGuide} />
      <BorosWalletRow {...rowProps('borosWallet')} />
      <TelegramRow {...rowProps('telegram')} />
    </div>
  );
}
