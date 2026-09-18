import { useCredentials } from '../../api/queries';
import { CredentialsForm } from '../../components/CredentialsForm';
import { Ext, GATE_API_KEYS_URL, PERMISSION_ROWS } from '../onboardingBits';
import { SetupRowFrame } from './SetupRowFrame';
import type { SetupRowProps } from './setupState';

export function GateKeyRow(p: SetupRowProps) {
  const credentials = useCredentials();
  const info = credentials.data;
  const isDone = info?.configured === true;
  const state = info?.configured ? [info.keyMasked, 'works'].filter(Boolean).join(' · ') : null;

  return (
    <SetupRowFrame n={1} title="Gate API key" row={p} isDone={isDone} state={state}>
      <Ext href={GATE_API_KEYS_URL}>How to make a key ↗</Ext>
      <div className="flex flex-col gap-1 text-xs">
        {PERMISSION_ROWS.map((permission) => (
          <div key={permission.label} className="flex items-baseline gap-2">
            <span aria-hidden="true" className={permission.on ? 'text-emerald-400' : 'text-rose-400'}>
              {permission.on ? '✓' : '✕'}
            </span>
            <span className="w-28 shrink-0 font-medium text-ink-100">{permission.label}</span>
            <span className="w-24 shrink-0 text-ink-300">{permission.value}</span>
            <span className="text-ink-500">{permission.detail}</span>
          </div>
        ))}
      </div>
      <CredentialsForm
        submitLabel={p.variant === 'settings' ? 'Replace credentials' : 'Check key'}
        onSaved={p.onDone}
      />
    </SetupRowFrame>
  );
}
