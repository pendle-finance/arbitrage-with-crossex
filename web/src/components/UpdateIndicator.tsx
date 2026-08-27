import { useState } from 'react';
import { ApiError } from '../api/client';
import { useRunUpdate, useVersion } from '../api/queries';
import { INSTALL_CMD, INSTALL_CMD_WINDOWS, REPO_URL } from '../lib/app';
import { CopyBlock } from './CopyBlock';
import { Modal } from './Modal';

const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;

type Os = 'macos' | 'windows';
const OS_LABEL: Record<Os, string> = { macos: 'macOS', windows: 'Windows (PowerShell)' };
/** The machine reading this. Only the default — the other OS stays one click
 * away, because a user copying the command for a second machine is common. */
const thisMachine = (): Os => (navigator.userAgent.includes('Windows') ? 'windows' : 'macos');
const installCmd = (os: Os, pin: string | null): string =>
  os === 'windows'
    ? pin
      ? `$env:BOROS_REF='${pin}'; ${INSTALL_CMD_WINDOWS}`
      : INSTALL_CMD_WINDOWS
    : pin
      ? `BOROS_REF=${pin} ${INSTALL_CMD}`
      : INSTALL_CMD;
const LINK_CLASS =
  'text-xs text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200';

export function UpdateIndicator() {
  const { data } = useVersion();
  const runUpdate = useRunUpdate();
  const [open, setOpen] = useState(false);
  const [os, setOs] = useState<Os>(thisMachine);
  if (!data?.updateAvailable || !data.latest) return null;

  const pin = data.latestCommit;
  // This machine first, so the command the user almost always wants is the one
  // under the cursor as well as the one selected.
  const order: Os[] = thisMachine() === 'windows' ? ['windows', 'macos'] : ['macos', 'windows'];
  const target = pin ?? 'main';
  const changesUrl = data.install?.commit
    ? `${REPO_URL}/compare/${data.install.commit}...${target}`
    : `${REPO_URL}/commits/${target}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Version ${data.latest} is available — click to review and update`}
        className="hdr-ctl border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
      >
        Update v{data.latest}
      </button>
      {open && (
        <Modal title={`Update available — v${data.latest}`} onClose={() => setOpen(false)} widthClass="w-[560px]">
          <div className="flex flex-col gap-4 px-5 py-5 text-sm leading-relaxed text-ink-200">
            <p>
              You're on <span className="num">v{data.current ?? 'unknown'}</span>. Version{' '}
              <span className="num">v{data.latest}</span> brings:
            </p>
            {data.highlights.length > 0 && (
              <ul className="list-disc pl-5 text-[13px] text-ink-300">
                {data.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            )}
            <p className="text-[13px] text-ink-300">
              Update runs this command on this machine. It stops the old version and swaps the new
              one in. Your keys and trade history are never touched. You can also paste it into a
              terminal yourself.
            </p>
            {pin && (
              <p className="text-[13px] text-ink-300">
                It installs commit <span className="num text-ink-200">{pin.slice(0, 7)}</span> —
                the exact code the link below shows, not whatever lands on the branch later.
              </p>
            )}
            <div className="flex flex-col">
              {/* Folder tabs, same recipe as TabBar: -mb-px pulls the strip down
                  over the block's top border, and the active tab's opaque
                  bg-ink-900 — the block's own colour — cuts that line, so the
                  two read as one surface. Flex items paint in document order, so
                  the strip needs z-10 or the block below repaints its own border
                  over the tab. Per-side border colours, never `border-*`, or the
                  cyan cap loses to the all-sides rule. */}
              <div
                role="tablist"
                aria-label="Operating system"
                className="relative z-10 -mb-px flex"
              >
                {order.map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={os === v}
                    onClick={() => setOs(v)}
                    className={`shrink-0 whitespace-nowrap rounded-t-md border-x border-t-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                      os === v
                        ? 'border-x-ink-700 border-t-cyan-400 bg-ink-900 text-ink-100'
                        : 'border-transparent text-ink-400 hover:border-t-ink-500 hover:bg-ink-900/40 hover:text-ink-200'
                    }`}
                  >
                    {OS_LABEL[v]}
                  </button>
                ))}
              </div>
              <CopyBlock text={installCmd(os, pin)} tabbed />
            </div>
            {runUpdate.data ? (
              <p
                role="status"
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300"
              >
                The install is running. It writes to{' '}
                <span className="num break-all">{runUpdate.data.logPath}</span>. This page loses the
                server for a few minutes while it works, then comes back on its own.
              </p>
            ) : (
              <button
                type="button"
                className="btn btn-primary self-start"
                disabled={runUpdate.isPending}
                onClick={() => runUpdate.mutate()}
              >
                {runUpdate.isPending ? 'Starting…' : `Update to v${data.latest}`}
              </button>
            )}
            {runUpdate.error != null && (
              <p
                role="alert"
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
              >
                {runUpdate.error instanceof ApiError
                  ? runUpdate.error.message
                  : String(runUpdate.error)}
              </p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <a href={changesUrl} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                Read the code changes →
              </a>
              <a href={CHANGELOG_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                Full changelog on GitHub →
              </a>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
