import { useState } from 'react';
import { ApiError } from '../api/client';
import { useRunUpdate, useVersion } from '../api/queries';
import { INSTALL_CMD, INSTALL_CMD_WINDOWS, REPO_URL } from '../lib/app';
import { CopyBlock } from './CopyBlock';
import { Modal } from './Modal';

const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;
const LINK_CLASS =
  'text-xs text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200';

export function UpdateIndicator() {
  const { data } = useVersion();
  const runUpdate = useRunUpdate();
  const [open, setOpen] = useState(false);
  if (!data?.updateAvailable || !data.latest) return null;

  const platform = navigator.userAgent.includes('Windows')
    ? { name: 'Windows (PowerShell)', cmd: INSTALL_CMD_WINDOWS }
    : { name: 'macOS', cmd: INSTALL_CMD };
  const changesUrl = data.install?.commit
    ? `${REPO_URL}/compare/${data.install.commit}...main`
    : `${REPO_URL}/commits/main`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Version ${data.latest} is available — click to review and update`}
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
              Update runs this command on this machine. It stops the old version and swaps the new
              one in. Your keys and trade history are never touched. You can also paste it into a
              terminal yourself.
            </p>
            <div className="flex flex-col gap-1.5">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                {platform.name}
              </h3>
              <CopyBlock text={platform.cmd} />
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
