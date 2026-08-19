import { useEffect, useState } from 'react';
import { CopyBlock } from '../components/CopyBlock';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { AUDIT_PROMPT, INSTALL_CMD, INSTALL_CMD_WINDOWS, LOCAL_APP_URL, REPO_URL } from '../lib/landing';
import { useTradeFlowOptional } from '../trade/TradeFlow';
import { Ext, GATE_API_KEYS_URL, GATE_CROSSEX_URL, GATE_SIGNUP_URL, Step, useNudge } from './onboardingBits';

type Os = 'macos' | 'windows';

/** Default the install command to the visitor's own platform, so the common
 * case is copy-and-go. Anything we can't identify falls back to macOS. */
function detectOs(): Os {
  if (typeof navigator === 'undefined') return 'macos';
  return /Windows|Win32|Win64/i.test(navigator.userAgent) ? 'windows' : 'macos';
}

/** Public-site rail: same shell and Gate steps as OnboardingGuide, but step 1 is
 * installing the terminal and no key ever touches this page — the API-key step
 * sends the visitor to the setup guide of their locally-running copy instead of
 * embedding the form, and the Execute nudge flashes the install command. */
export function LandingOnboardingGuide() {
  const flow = useTradeFlowOptional();
  const nonce = flow?.pairPrefill?.nonce ?? 0;
  const { ref: installRef, flash } = useNudge(nonce);
  const [os, setOs] = useState<Os>(detectOs);
  const windows = os === 'windows';

  // Only step 1 starts open: the install command — and the audit prompt above it
  // — are what a first-time visitor needs in front of them, while the remaining
  // steps' full content would bury the live rates that are the actual pitch.
  // The rest read as scannable titles.
  const [openSteps, setOpenSteps] = useState<ReadonlySet<number>>(() => new Set([1]));
  const toggle = (n: number) =>
    setOpenSteps((prev) => {
      const next = new Set(prev);
      if (!next.delete(n)) next.add(n);
      return next;
    });
  const step = (n: number) => ({
    collapsible: true as const,
    open: openSteps.has(n),
    onToggle: () => toggle(n),
  });

  // The Execute nudge flashes the install command — open its step first, or
  // there is nothing on screen to flash.
  useEffect(() => {
    if (!nonce) return;
    setOpenSteps((prev) => (prev.has(1) ? prev : new Set(prev).add(1)));
  }, [nonce]);

  return (
    <aside
      className="w-full shrink-0 lg:sticky lg:top-16 lg:w-[360px] lg:self-start"
      aria-label="Setup guide"
    >
      <div className="card px-5 py-5">
        <h2 className="text-xl font-bold tracking-tight text-ink-100">How to execute</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-300">
          Every number on the left is live. Four steps and you can take them.
        </p>
        <ol className="mt-5 flex flex-col gap-[18px]">
          <Step n={1} title="Install the terminal" active {...step(1)}>
            Runs locally on your own machine — free and <Ext href={REPO_URL}>open source</Ext>.
            Audit it first if you want, then pick your system, paste the command and press Return:
            {/* Above the command, not below it: the point of the audit is to read
                the source BEFORE running anything. */}
            <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-ink-800 bg-ink-950/60 p-2.5">
              <span className="text-[10.5px] leading-relaxed text-ink-400">
                Don’t take our word for it — paste this into whichever assistant you trust
                (ChatGPT, Claude, Gemini) and have it read the source:
              </span>
              {/* The prompt is ~15 lines and would otherwise be the tallest
                  thing in the rail — show a few and let it scroll. */}
              <CopyBlock text={AUDIT_PROMPT} label="Copy audit prompt" maxHeightClass="max-h-20" />
            </div>
            <div
              ref={installRef}
              className="relative mt-2 flex flex-col gap-2 rounded-lg border border-ink-700 bg-ink-950 p-3"
            >
              {flash && <div aria-hidden="true" className="flash-ring" />}
              <SegmentedToggle<Os>
                ariaLabel="Operating system"
                value={os}
                onChange={setOs}
                options={[
                  { value: 'macos', label: <span className="text-xs">macOS</span> },
                  { value: 'windows', label: <span className="text-xs">Windows</span> },
                ]}
              />
              <CopyBlock text={windows ? INSTALL_CMD_WINDOWS : INSTALL_CMD} />
              <span className="text-[10.5px] leading-relaxed text-ink-400">
                {windows
                  ? 'In Windows PowerShell — press Win, type PowerShell, open it. Windows 10 or 11; nothing to install first.'
                  : 'In the Terminal app.'}
              </span>
              <a
                href={LOCAL_APP_URL}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary justify-center text-xs font-semibold"
              >
                After that, open http://localhost:6688 ↗
              </a>
              <span className="text-center text-[10.5px] text-ink-400">
                It never asks for keys in the terminal.
              </span>
            </div>
          </Step>
          {/* One Gate step, not three: signing up, switching CrossEx on and
              moving funds into it are a single sitting on gate.com, and three
              one-line steps made the rail read longer than the work is. The
              ORDER still matters — CrossEx must be on before funds can move
              into it — so it stays a numbered list inside the step. */}
          <Step n={2} title="Fund Gate and enable CrossEx" {...step(2)}>
            All three on gate.com, in this order:
            <ol className="mt-1.5 flex list-decimal flex-col gap-1 pl-4 marker:text-ink-500">
              <li>
                Sign up at <Ext href={GATE_SIGNUP_URL}>gate.com/signup</Ext> and deposit the
                capital you’ll deploy.
              </li>
              <li>
                Switch on CrossEx at <Ext href={GATE_CROSSEX_URL}>gate.com/crossex</Ext> — both
                the transfer below and the API-key permission need it enabled first.
              </li>
              <li>Move your funds into CrossEx, Gate’s cross-exchange margin account.</li>
            </ol>
          </Step>
          <Step n={3} title="Create your API key" {...step(3)}>
            In <Ext href={GATE_API_KEYS_URL}>API Management</Ext>, create an APIv4 key for your
            Trading account. Set IP Permissions to “Later” (unless your machine has a consistent
            IP), and under Permissions tick only Cross-Exchange with Read and Write; leave
            Withdrawal off. Paste it into the setup guide of your locally-running terminal
            at <Ext href={LOCAL_APP_URL}>localhost:6688</Ext> — keys stay on your machine and
            never touch this website.
          </Step>
          {/* "in your terminal", not "on any card": the public build has no
              Execute button — it would only ever render disabled here. */}
          <Step n={4} title="Execute" {...step(4)}>
            Hit Execute on any spread in your terminal; all four legs land pre-filled.
          </Step>
        </ol>
      </div>
    </aside>
  );
}
