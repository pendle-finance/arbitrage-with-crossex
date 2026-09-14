import { CredentialsForm } from '../components/CredentialsForm';
import { useTradeFlowOptional } from '../trade/TradeFlow';
import {
  Ext,
  GATE_API_KEYS_URL,
  GATE_CROSSEX_URL,
  GATE_SIGNUP_URL,
  PERMISSION_ROWS,
  Step,
  useNudge,
} from './onboardingBits';

function PermissionRow({
  on,
  label,
  value,
  detail,
  last,
}: {
  on: boolean;
  label: string;
  value: string;
  detail: string;
  last: boolean;
}) {
  const border = last ? '' : 'border-b border-ink-700';
  return (
    <div className={`grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 px-2.5 py-1.5 ${border}`}>
      <span aria-hidden="true" className={`w-4 text-center ${on ? 'text-grass' : 'text-guava'}`}>
        {on ? '✓' : '✕'}
      </span>
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-ink-100">{label}</span>
          <span className="text-ink-200">{value}</span>
        </div>
        <div className="text-[10.5px] text-ink-400">{detail}</div>
      </div>
    </div>
  );
}

/** First-run right rail: the 4-step Gate onboarding with the credentials form.
 * Replaces the order ticket while credentials are unconfigured. Clicking a
 * card's "Open this strategy" bumps `setupNonce` — the wizard deliberately
 * stays shut, since with no keys it could not execute — and the guide answers
 * by scrolling to and flashing the API-key form, the one step standing between
 * that click and a wizard that can trade. (The prefill nonce still counts too:
 * the Positions cues arm the ticket directly.) */
export function OnboardingGuide() {
  const flow = useTradeFlowOptional();
  const nonce = (flow?.setupNonce ?? 0) + (flow?.pairPrefill?.nonce ?? 0);
  const { ref: formRef, flash } = useNudge(nonce);

  return (
    <aside className="sticky top-16 w-[360px] shrink-0 self-start" aria-label="Setup guide">
      <div className="card px-5 py-5">
        <h2 className="text-xl font-bold tracking-tight text-ink-100">How to execute</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-300">
          Every number on the left is live. Five steps and you can take them.
        </p>
        <ol className="mt-5 flex flex-col gap-[18px]">
          <Step n={1} title="Fund Gate">
            Sign up on <Ext href={GATE_SIGNUP_URL}>gate.com/signup</Ext>, deposit the capital
            you’ll deploy.
          </Step>
          <Step n={2} title="Enable CrossEx">
            Switch on the CrossEx feature at <Ext href={GATE_CROSSEX_URL}>gate.com/crossex</Ext>.
            The API-key permission and the transfer below need it enabled first.
          </Step>
          <Step n={3} title="Fund CrossEx">
            Move funds into <Ext href={GATE_CROSSEX_URL}>CrossEx</Ext>, Gate’s cross-exchange
            margin account.
          </Step>
          <Step n={4} title="Paste your API key" active>
            In <Ext href={GATE_API_KEYS_URL}>API Management</Ext>, create an APIv4 key for your
            Trading account. Set IP Permissions to “Later” (unless your machine has a consistent
            IP). Under Permissions:
            <div className="mt-2 rounded-lg border border-ink-700 text-xs">
              {PERMISSION_ROWS.map((row, i) => (
                <PermissionRow key={row.label} {...row} last={i === PERMISSION_ROWS.length - 1} />
              ))}
            </div>
            <div
              ref={formRef}
              className="relative mt-2 flex flex-col gap-2 rounded-lg border border-ink-700 bg-ink-950 p-3"
            >
              {flash && <div aria-hidden="true" className="flash-ring" />}
              <CredentialsForm submitLabel="Save credentials" />
              <span className="text-center text-[10.5px] text-ink-400">
                Keys stay on this machine.
              </span>
            </div>
          </Step>
          <Step n={5} title="Execute">
            Hit Execute on any card; all four legs land pre-filled.
          </Step>
        </ol>
      </div>
    </aside>
  );
}
