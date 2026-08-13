import { useState, type ReactNode } from 'react';
import { CopyBlock } from '../components/CopyBlock';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { INSTALL_CMD, INSTALL_CMD_WINDOWS, LOCAL_APP_URL } from '../lib/landing';
import { Ext, GATE_API_KEYS_URL, GATE_CROSSEX_URL, GATE_SIGNUP_URL } from '../panels/onboardingBits';

type Os = 'macos' | 'windows';

function detectOs(): Os {
  if (typeof navigator === 'undefined') return 'macos';
  return /Windows|Win32|Win64/i.test(navigator.userAgent) ? 'windows' : 'macos';
}

/**
 * "Three things you need" — the page's ONLY setup surface.
 *
 * This used to be three teaser cards followed by a separate step-by-step rail
 * at the bottom saying the same things again in a different shape. The rail is
 * gone; every instruction it carried lives in the matching card here, so a
 * visitor reads the setup once. Each card is a THING you need (a terminal, a
 * funded account, a key), with the clicks that get it underneath — rather than
 * an abstract step whose payoff is only clear later.
 *
 * Order inside card 2 is load-bearing and must stay a numbered list: CrossEx
 * has to be switched on before funds can move into it, and before the key can
 * carry the Cross-Exchange permission.
 */
function ThingCard({
  n,
  title,
  what,
  children,
}: {
  n: number;
  title: string;
  /** One line: what this thing IS, before any instruction. */
  what: string;
  children: ReactNode;
}) {
  return (
    <div className="card flex flex-col gap-3 p-5">
      <div className="flex items-center gap-3">
        <span className="num flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/10 text-base font-bold text-cyan-300">
          {n}
        </span>
        <h3 className="text-base font-bold tracking-tight text-ink-100">{title}</h3>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-300">{what}</p>
      <div className="mt-auto flex flex-col gap-2 pt-1">{children}</div>
    </div>
  );
}

/** The muted instruction block inside a card — where the old rail's step body
 * text now lives. */
function How({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-ink-800 bg-ink-950/60 p-2.5 text-[10.5px] leading-relaxed text-ink-400">
      {children}
    </div>
  );
}

export function ThreeThings() {
  const [os, setOs] = useState<Os>(detectOs);
  const windows = os === 'windows';

  return (
    <section
      id="three-things"
      className="mx-auto flex w-full max-w-5xl scroll-mt-20 flex-col gap-4 px-1"
    >
      <div className="text-center">
        <h2 className="text-2xl font-extrabold tracking-tight text-ink-100 sm:text-3xl">
          Three things you need
        </h2>
        <p className="mx-auto mt-1.5 max-w-xl text-sm text-ink-400">
          That's the whole setup. Nothing to sign up for here — it runs on your machine, against
          your own Gate account.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <ThingCard
          n={1}
          title="The terminal, running locally"
          what="One command. Free and open source. Your keys never leave your machine."
        >
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
          <How>
            <span>
              {windows
                ? 'In Windows PowerShell — press Win, type PowerShell, open it. Windows 10 or 11; nothing to install first.'
                : 'In the Terminal app. Paste it and press Return.'}
            </span>
            <span>
              Then open <Ext href={LOCAL_APP_URL}>localhost:6688</Ext> — that's your copy, and the
              only place a key is ever entered.
            </span>
          </How>
        </ThingCard>

        <ThingCard
          n={2}
          title="A funded CrossEx account"
          what="Capital on Gate, moved into CrossEx — plus a little on-chain gas for the Boros legs."
        >
          <How>
            <span className="text-ink-300">All on gate.com, in this order:</span>
            <ol className="flex list-decimal flex-col gap-0.5 pl-4 marker:text-ink-500">
              <li>Sign up and deposit the capital you'll deploy.</li>
              <li>
                Switch on <Ext href={GATE_CROSSEX_URL}>CrossEx</Ext> — the transfer and the key
                permission both need it enabled first.
              </li>
              <li>Move your funds into CrossEx, Gate's cross-exchange margin account.</li>
            </ol>
            <span>Keep a little gas in your own wallet for the Boros side.</span>
          </How>
          <a
            href={GATE_SIGNUP_URL}
            target="_blank"
            rel="noreferrer"
            className="btn btn-primary justify-center text-xs font-semibold"
          >
            Sign up at gate.com ↗
          </a>
        </ThingCard>

        <ThingCard
          n={3}
          title="One API key"
          what="Scoped so it can trade for you and nothing else. It goes into your local copy, not this site."
        >
          <How>
            <span>
              In <Ext href={GATE_API_KEYS_URL}>API Management</Ext>, create an APIv4 key for your
              Trading account.
            </span>
            <span>
              IP Permissions: <span className="text-ink-300">Later</span>, unless your machine has a
              consistent IP.
            </span>
            <span>
              Permissions: tick only{' '}
              <span className="text-ink-300">Cross-Exchange, Read and Write</span>. Leave Withdrawal
              off.
            </span>
            <span>
              Paste it into <Ext href={LOCAL_APP_URL}>localhost:6688</Ext>.
            </span>
          </How>
        </ThingCard>
      </div>

      <p className="text-center text-[13px] text-ink-400">
        Then hit <span className="font-semibold text-ink-200">Execute</span> on any spread in your
        terminal — all four legs land pre-filled.
      </p>
    </section>
  );
}
