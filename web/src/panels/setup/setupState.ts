import { useBorosAgent, useCredentials, useTelegram } from '../../api/queries';
import { isSameAddress, useTrackedAddress } from '../trackedAddress';

export type SetupStep = 'gateKey' | 'borosWallet' | 'telegram';

export const SETUP_STEPS: readonly SetupStep[] = ['gateKey', 'borosWallet', 'telegram'];

export const SETUP_SHOWN_KEY = 'crossex.setupShown.v1';

export interface SetupRowProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDone: () => void;
  onSkip?: () => void;
  variant: 'setup' | 'settings';
}

type StepState = 'done' | 'missing';

export function useSetupState(): {
  steps: Record<SetupStep, StepState>;
  doneCount: number;
  firstMissing: SetupStep | null;
  isLoading: boolean;
} {
  const credentials = useCredentials();
  const agent = useBorosAgent();
  const telegram = useTelegram();
  const { address } = useTrackedAddress();
  const steps: Record<SetupStep, StepState> = {
    gateKey: credentials.data?.configured ? 'done' : 'missing',
    borosWallet:
      !address ||
      (agent.data?.configured && agent.data.expired && agent.data.root !== null && isSameAddress(agent.data.root, address))
        ? 'missing'
        : 'done',
    telegram: telegram.data?.connected && telegram.data.state === 'connected' ? 'done' : 'missing',
  };
  const missing = SETUP_STEPS.filter((step) => steps[step] === 'missing');
  return {
    steps,
    doneCount: SETUP_STEPS.length - missing.length,
    firstMissing: missing[0] ?? null,
    isLoading: credentials.isPending || agent.isPending || telegram.isPending,
  };
}
