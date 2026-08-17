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
 * Order inside card 3 is load-bearing and must stay a numbered list: CrossEx
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
    // Fixed rows, not mt-auto: the intro line wraps to 2 lines in some cards
    // and 1 in others, and pushing the body to the bottom made every card's
    // content start at a different height. `min-h-[2.5rem]` reserves two lines
    // for the intro so the body always begins on the same line across all three.
    <div className="card flex flex-col gap-3 p-5">
      <div className="flex items-center gap-3">
        <span className="num flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/10 text-base font-bold text-cyan-300">
          {n}
        </span>
        <h3 className="text-base font-bold tracking-tight text-ink-100">{title}</h3>
      </div>
      <p className="min-h-[2.5rem] text-[13px] leading-relaxed text-ink-300">{what}</p>
      <div className="flex flex-1 flex-col gap-2">{children}</div>
    </div>
  );
}

/** The muted instruction block inside a card — where the old rail's step body
 * text now lives. */
function How({ children }: { children: ReactNode }) {
  return (
    // mt-auto: the instruction block is the LAST thing in every card, so
    // pinning it to the bottom lines the three blocks up with each other even
    // though the controls above them differ in height (card 1 carries an OS
    // toggle and a copy box; card 2 carries nothing).
    <div className="mt-auto flex flex-col gap-1 rounded-lg border border-ink-800 bg-ink-950/60 p-2.5 text-[10.5px] leading-relaxed text-ink-400">
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
      className="w-full scroll-mt-20 flex flex-col gap-4 px-1"
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
          title="The terminal"
          what="One command. Free, open source, runs on your machine."
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
                ? 'Windows PowerShell (press Win, type PowerShell). Windows 10 or 11, nothing to install first.'
                : 'Terminal app. Paste, press Return.'}
            </span>
            <span>
              Opens at <Ext href={LOCAL_APP_URL}>localhost:6688</Ext>.
            </span>
          </How>
        </ThingCard>

        {/* Key before funding: the key is what the terminal needs to do
            anything, and its Cross-Exchange permission is the same switch the
            transfer needs — so enabling CrossEx once here covers both. Signup
            lives here too, with the CTA, since this is the first card that
            sends a visitor to gate.com. */}
        <ThingCard
          n={2}
          title="A Gate API key"
          what="Scoped to trade, nothing else. Goes into your local copy, never this site."
        >
          {/* CTA before the How block: How is mt-auto (pins to the card
              bottom), so a button after it would sit below the aligned row. */}
          <a
            href={GATE_SIGNUP_URL}
            target="_blank"
            rel="noreferrer"
            className="btn btn-primary justify-center text-xs font-semibold"
          >
            Sign up at gate.com ↗
          </a>
          <How>
            <ol className="flex list-decimal flex-col gap-0.5 pl-4 marker:text-ink-500">
              <li>Sign up on gate.com.</li>
              <li>
                Switch on <Ext href={GATE_CROSSEX_URL}>CrossEx</Ext> — the key permission and the
                transfer both need it.
              </li>
              <li>
                In <Ext href={GATE_API_KEYS_URL}>API Management</Ext>, create an APIv4 key for your
                Trading account.
              </li>
              <li>
                IP Permissions: <span className="text-ink-300">Later</span>, unless your IP is
                fixed.
              </li>
              <li>
                Tick only <span className="text-ink-300">Cross-Exchange, Read and Write</span>.
                Withdrawal off.
              </li>
              <li>
                Paste it into <Ext href={LOCAL_APP_URL}>localhost:6688</Ext>.
              </li>
            </ol>
          </How>
        </ThingCard>

        <ThingCard
          n={3}
          title="A funded CrossEx account"
          what="Capital on Gate, moved into CrossEx."
        >
          <How>
            <ol className="flex list-decimal flex-col gap-0.5 pl-4 marker:text-ink-500">
              <li>Deposit your capital on Gate.</li>
              <li>Move it into CrossEx, Gate's cross-exchange margin account.</li>
              <li>Keep a little gas in your own wallet for the Boros legs.</li>
            </ol>
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
