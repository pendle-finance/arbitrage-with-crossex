/**
 * "Update available" pill + instructions modal. Renders nothing unless the
 * server's update check (GET /api/version — cached GitHub read, silent on
 * failure) reports a genuinely newer published version, so the header stays
 * clean in the common case. Deliberately passive: nothing auto-opens and
 * there is no dismissal state — releases are hand-bumped "substantial only",
 * and for software that places real orders the nudge should stay visible.
 */
import { useState } from 'react';
import { useVersion } from '../api/queries';
import { INSTALL_CMD, INSTALL_CMD_WINDOWS, REPO_URL } from '../lib/app';
import { CopyBlock } from './CopyBlock';
import { Modal } from './Modal';

const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;

export function UpdateIndicator() {
  const { data } = useVersion();
  const [open, setOpen] = useState(false);
  if (!data?.updateAvailable || !data.latest) return null;

  const isWindows = navigator.userAgent.includes('Windows');
  const sections = [
    { name: 'macOS', cmd: INSTALL_CMD, thisMachine: !isWindows },
    { name: 'Windows (PowerShell)', cmd: INSTALL_CMD_WINDOWS, thisMachine: isWindows },
  ].sort((a, b) => Number(b.thisMachine) - Number(a.thisMachine));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Version ${data.latest} is available — click for update instructions`}
        className="self-center whitespace-nowrap rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs text-amber-400 transition-colors hover:bg-amber-500/20"
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
              To update, paste the install command into a terminal — it stops the old version and
              swaps the new one in. Your keys and trade history are never touched.
            </p>
            {sections.map((s) => (
              <div key={s.name} className="flex flex-col gap-1.5">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                  {s.name}
                  {s.thisMachine && <span className="ml-1.5 text-ink-500">(this machine)</span>}
                </h3>
                <CopyBlock text={s.cmd} />
              </div>
            ))}
            <a
              href={CHANGELOG_URL}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200"
            >
              Full changelog on GitHub →
            </a>
          </div>
        </Modal>
      )}
    </>
  );
}
