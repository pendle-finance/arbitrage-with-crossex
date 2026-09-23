import { Check, X } from 'lucide-react';
import { useCredentials } from '../../api/queries';
import { Fragment, type ReactNode } from 'react';
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

/**
 * The steps and the key settings share one grid, so a step's name lines up
 * with a permission's name, and its link with the permission's value. Columns
 * size to their text, so nothing wraps in the 420 px Settings drawer. The
 * list and row wrappers are `contents`: they keep the list semantics without
 * boxes of their own.
 */
function KeyGuide({ showSteps }: { showSteps: boolean }) {
  return (
    <div className="grid grid-cols-[auto_auto_auto_1fr] items-baseline gap-x-2 gap-y-1 text-xs">
      {showSteps && (
        <ol aria-label="Steps to a key" className="contents">
          {GATE_STEPS.map((step, i) => (
            <li key={step.title} className="contents">
              <span className="num text-ink-500">{i + 1}</span>
              <span className="whitespace-nowrap font-medium text-ink-100">
                <HoverCard label={step.title} icon={false} widthPx={300}>
                  <p className="text-xs leading-relaxed text-ink-200">{step.detail}</p>
                </HoverCard>
              </span>
              <span className="col-span-2 whitespace-nowrap">
                <Ext href={step.href}>{step.site}</Ext>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className={`col-span-4 text-ink-300 ${showSteps ? 'mt-1' : ''}`}>
        APIv4 key · Trading account · IP Permissions: Later
      </div>
      {PERMISSION_ROWS.map((permission) => (
        <Fragment key={permission.label}>
          <span aria-hidden="true" className={permission.on ? 'text-emerald-400' : 'text-rose-400'}>
            {permission.on ? <Check size={12} aria-hidden className="inline" /> : <X size={12} aria-hidden className="inline" />}
          </span>
          <span className="whitespace-nowrap font-medium text-ink-100">{permission.label}</span>
          <span className="whitespace-nowrap text-ink-300">{permission.value}</span>
          <span className="text-ink-500">{permission.detail}</span>
        </Fragment>
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
      <KeyGuide showSteps={!isDone} />
      <CredentialsForm
        submitLabel={p.variant === 'settings' ? 'Replace credentials' : 'Check key'}
        onSaved={p.onDone}
      />
    </SetupRowFrame>
  );
}
