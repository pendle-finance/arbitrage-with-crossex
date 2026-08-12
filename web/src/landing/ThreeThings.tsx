import { useState } from 'react';
import { CopyBlock } from '../components/CopyBlock';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { INSTALL_CMD, INSTALL_CMD_WINDOWS } from '../lib/landing';
import { Ext, GATE_API_KEYS_URL, GATE_CROSSEX_URL, GATE_SIGNUP_URL } from '../panels/onboardingBits';

type Os = 'macos' | 'windows';

function detectOs(): Os {
  if (typeof navigator === 'undefined') return 'macos';
  return /Windows|Win32|Win64/i.test(navigator.userAgent) ? 'windows' : 'macos';
}

/** One numbered card: an icon-weight number, a title, prose, and its own CTA.
 * Kept as a plain div grid (not <ol>/<li>) because card 1 needs a bespoke OS
 * toggle inside its CTA slot that a shared list item shouldn't have to know
 * about. */
function ThingCard({
  n,
  title,
  children,
  cta,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  cta: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col gap-3 p-5">
      <div className="flex items-center gap-3">
        <span className="num flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/10 text-base font-bold text-cyan-300">
          {n}
        </span>
        <h3 className="text-base font-bold tracking-tight text-ink-100">{title}</h3>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-300">{children}</p>
      <div className="mt-auto pt-1">{cta}</div>
    </div>
  );
}

/** The "3 things you need" section: same three items as the setup rail, but
 * presented as parallel, scannable cards rather than a sequential accordion.
 * The rail further down is for someone who has decided and wants the
 * step-by-step; this is the shop window's "how do I get this". */
export function ThreeThings() {
  const [os, setOs] = useState<Os>(detectOs);
  const windows = os === 'windows';

  return (
    <section id="three-things" className="mx-auto flex w-full max-w-5xl scroll-mt-20 flex-col gap-4 px-1">
      <div className="text-center">
        <h2 className="text-2xl font-extrabold tracking-tight text-ink-100 sm:text-3xl">
          Three things
        </h2>
        <p className="mx-auto mt-1.5 max-w-xl text-sm text-ink-400">
          Nothing to sign up for here. Runs on your machine, your Gate account.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <ThingCard
          n={1}
          title="Install the terminal"
          cta={
            <div className="flex flex-col gap-2">
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
            </div>
          }
        >
          One command. Free, open source. Runs locally. Keys stay on your machine.
        </ThingCard>

        <ThingCard
          n={2}
          title="A Gate account with API keys"
          cta={
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1 rounded-lg border border-ink-800 bg-ink-950/60 p-2.5 text-[10.5px] leading-relaxed text-ink-400">
                <span>
                  Enable <Ext href={GATE_CROSSEX_URL}>CrossEx</Ext> first.
                </span>
                <span>
                  Key scope: Cross-Exchange Read + Write. Never Withdrawal.
                </span>
              </div>
              <a
                href={GATE_SIGNUP_URL}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary justify-center text-xs font-semibold"
              >
                Sign up at gate.com ↗
              </a>
              <span className="text-center text-[10.5px] text-ink-400">
                Then generate the key in <Ext href={GATE_API_KEYS_URL}>API Management</Ext>.
              </span>
            </div>
          }
        >
          One key. Runs your side of the trade automatically once it's set.
        </ThingCard>

        <ThingCard
          n={3}
          title="A funded CrossEx account"
          cta={
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1 rounded-lg border border-ink-800 bg-ink-950/60 p-2.5 text-[10.5px] leading-relaxed text-ink-400">
                <span>Capital in CrossEx for the perp legs.</span>
                <span>A little gas in your wallet for the Boros legs.</span>
              </div>
              <a
                href={GATE_CROSSEX_URL}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary justify-center text-xs font-semibold"
              >
                Fund CrossEx ↗
              </a>
            </div>
          }
        >
          Two balances: exchange capital and a little on-chain gas.
        </ThingCard>
      </div>
    </section>
  );
}
