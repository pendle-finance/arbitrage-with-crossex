import { Check, X } from 'lucide-react';
import { useCredentials } from '../../api/queries';
import type { ReactNode } from 'react';
import { CredentialsForm } from '../../components/CredentialsForm';
import { HoverCard } from '../../components/HoverCard';
import { Ext, GATE_API_KEYS_URL, GATE_CROSSEX_URL, GATE_SIGNUP_URL, PERMISSION_ROWS } from '../onboardingBits';
import { SetupRowFrame } from './SetupRowFrame';
import type { SetupRowProps } from './setupState';

/** The Gate steps to a key, as the 1.7.0 guide had them. The terminal cannot
 * check them, so they are a list, not checklist rows. The hover keeps the
 * guide's detail; step 4 also shows the key settings under it. */
const GATE_STEPS: { title: string; href: string; site: string; detail: ReactNode }[] = [
  {
    title: 'Fund Gate',
    href: GATE_SIGNUP_URL,
    site: 'gate.com/signup',
    detail: (
      <>
        Sign up on <Ext href={GATE_SIGNUP_URL}>gate.com/signup</Ext>. Deposit the capital you will deploy.
      </>
    ),
  },
  {
    title: 'Enable CrossEx',
    href: GATE_CROSSEX_URL,
    site: 'gate.com/crossex',
    detail: (
      <>
        Switch on CrossEx at <Ext href={GATE_CROSSEX_URL}>gate.com/crossex</Ext>. The Cross-Exchange key permission
        and transfers need it first.
      </>
    ),
  },
  {
    title: 'Fund CrossEx',
    href: GATE_CROSSEX_URL,
    site: 'gate.com/crossex',
    detail: (
      <>
        Move funds into <Ext href={GATE_CROSSEX_URL}>CrossEx</Ext>, Gate's cross-exchange margin account. Every
        CrossEx trade uses this margin.
      </>
    ),
  },
  {
    title: 'Make an API key',
    href: GATE_API_KEYS_URL,
    site: 'API Management',
    detail: (
      <>
        In <Ext href={GATE_API_KEYS_URL}>API Management</Ext>, create an APIv4 key for your Trading account. Set IP
        Permissions to "Later" unless your IP is fixed.
      </>
    ),
  },
];

function GateSteps() {
  return (
    <ol aria-label="Steps to a key" className="flex flex-col gap-1 text-xs">
      {GATE_STEPS.map((step, i) => (
        <li key={step.title} className="flex items-baseline gap-2">
          <span className="num w-3 shrink-0 text-ink-500">{i + 1}</span>
          <span className="w-28 shrink-0 font-medium text-ink-100">
            <HoverCard label={step.title} icon={false} widthPx={300}>
              <p className="text-xs leading-relaxed text-ink-200">{step.detail}</p>
            </HoverCard>
          </span>
          <Ext href={step.href}>{step.site}</Ext>
        </li>
      ))}
    </ol>
  );
}

/** Step 4's settings: the key type, then the permissions to tick. */
function KeySettings() {
  return (
    <div className="flex flex-col gap-1 pl-5 text-xs">
      <div className="text-ink-300">APIv4 key · Trading account · IP Permissions: Later</div>
      {PERMISSION_ROWS.map((permission) => (
        <div key={permission.label} className="flex items-baseline gap-2">
          <span aria-hidden="true" className={permission.on ? 'text-emerald-400' : 'text-rose-400'}>
            {permission.on ? <Check size={12} aria-hidden className="inline" /> : <X size={12} aria-hidden className="inline" />}
          </span>
          <span className="w-28 shrink-0 font-medium text-ink-100">{permission.label}</span>
          <span className="w-24 shrink-0 text-ink-300">{permission.value}</span>
          <span className="text-ink-500">{permission.detail}</span>
        </div>
      ))}
    </div>
  );
}

export function GateKeyRow(p: SetupRowProps) {
  const credentials = useCredentials();
  const info = credentials.data;
  const isDone = info?.configured === true;
  const state = info?.configured ? [info.keyMasked, 'works'].filter(Boolean).join(' · ') : null;

  return (
    <SetupRowFrame n={1} title="Gate API key" row={p} isDone={isDone} state={state}>
      {/* A set-up terminal replacing its key needs only the settings. */}
      {!isDone && <GateSteps />}
      <KeySettings />
      <CredentialsForm
        submitLabel={p.variant === 'settings' ? 'Replace credentials' : 'Check key'}
        onSaved={p.onDone}
      />
    </SetupRowFrame>
  );
}
