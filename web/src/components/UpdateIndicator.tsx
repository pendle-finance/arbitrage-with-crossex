import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { useInstallWatch, useRunUpdate, useUpdateLog, useVersion } from '../api/queries';
import { INSTALL_CMD, INSTALL_CMD_WINDOWS, REPO_URL } from '../lib/app';
import { readUpdateLog } from '../lib/updateProgress';
import { CopyBlock } from './CopyBlock';
import { Modal } from './Modal';

const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;

type Os = 'macos' | 'windows';

const INSTALL_BY_OS: Record<Os, string> = { macos: INSTALL_CMD, windows: INSTALL_CMD_WINDOWS };
const thisMachine = (): Os => (navigator.userAgent.includes('Windows') ? 'windows' : 'macos');

const LINK_CLASS =
  'text-xs text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200';

export function UpdateIndicator() {
  const { data } = useVersion();
  const runUpdate = useRunUpdate();
  const [open, setOpen] = useState(false);
  const [stalled, setStalled] = useState(false);

  const started = runUpdate.data != null;
  const log = useUpdateLog(started);
  const { failed, plain } = readUpdateLog(log.data?.text ?? '');
  const offline = log.isError;
  const neverStarted = stalled && !offline && !failed && plain.trim() === '';
  const running = started && !failed && !neverStarted;

  useEffect(() => {
    setStalled(false);
    if (!started) return;
    const t = setTimeout(() => setStalled(true), 30_000);
    return () => clearTimeout(t);
  }, [started]);

  /**
   * RELOAD ONTO THE NEW BUNDLE, once the swap has actually happened.
   *
   * After a successful update this page reconnects to the new server still
   * running the OLD javascript, and its version answer is cached for six
   * hours. So the badge went on reading "Update available" for something the
   * machine already had — and clicking it again re-ran the installer and
   * re-opened the ten-minute window that refuses every Boros write.
   *
   * The commit is the signal, not a timer: it changes exactly when the new
   * copy is serving, however long the install took.
   */
  const installedCommit = data?.install?.commit ?? null;
  const watch = useInstallWatch(running || (data?.updateAvailable === true && !data.packageReady));
  const servingCommit = watch.data?.install?.commit ?? null;
  useEffect(() => {
    if (installedCommit && servingCommit && servingCommit !== installedCommit) {
      window.location.reload();
    }
  }, [installedCommit, servingCommit]);

  if (!data?.updateAvailable || !data.latest) return null;

  const packageReady = watch.data?.packageReady ?? data.packageReady;
  const target = data.latestCommit ?? 'main';
  const changesUrl = data.install?.commit
    ? `${REPO_URL}/compare/${data.install.commit}...${target}`
    : `${REPO_URL}/commits/${target}`;
  const stopped = failed || neverStarted;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          running
            ? 'The update is installing — click to watch it'
            : `Version ${data.latest} is available — click to review and update`
        }
        className="hdr-ctl border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
      >
        {running ? 'Updating…' : `Update v${data.latest}`}
      </button>
      {open && (
        <Modal
          title={running ? `Updating to v${data.latest}` : `Update available — v${data.latest}`}
          onClose={() => setOpen(false)}
          widthClass="w-[560px]"
        >
          <div className="flex flex-col gap-4 px-5 py-5 text-sm leading-relaxed text-ink-200">
            <div>
              <p className="text-[13px] text-ink-400">
                You&rsquo;re on <span className="num">v{data.current ?? 'unknown'}</span>.
              </p>
              {data.highlights.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-ink-300">
                  {data.highlights.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              )}
            </div>

            {started ? (
              <div
                role="status"
                className={`rounded-lg border p-3 ${
                  stopped ? 'border-rose-500/40 bg-rose-500/[0.06]' : 'border-ink-700 bg-ink-950/60'
                }`}
              >
                <div className="flex items-baseline gap-2">
                  {stopped && <span className="text-rose-400">✕</span>}
                  <span className="min-w-0 flex-1 text-[13px] text-ink-100">
                    {failed
                      ? 'The update failed. Your previous version is running again.'
                      : neverStarted
                        ? 'The update did not start.'
                        : offline
                          ? 'Restarting the app…'
                          : `Installing v${data.latest}. This page reloads itself when it is done.`}
                  </span>
                </div>

                {stopped && (
                  <>
                    <p className="mt-2.5 text-[12px] text-ink-400">
                      Your keys and trade history are untouched. Run the command yourself, or try
                      again.
                    </p>
                    <div className="mt-2">
                      <CopyBlock text={INSTALL_BY_OS[thisMachine()]} />
                    </div>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-ink-500 hover:text-ink-300">
                        Show log
                      </summary>
                      <pre className="num mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-ink-800 bg-ink-950 p-2 text-[10px] leading-relaxed text-ink-400">
                        {plain.trim() || 'nothing yet'}
                      </pre>
                      <p className="num mt-1 break-all text-[10px] text-ink-600">
                        {runUpdate.data?.logPath ?? ''}
                      </p>
                    </details>
                    <button
                      type="button"
                      className="btn mt-2.5 text-xs"
                      onClick={() => runUpdate.reset()}
                    >
                      Try again
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3 rounded-lg border border-ink-700 bg-ink-950/60 p-3">
                <p className="text-[12px] text-ink-400">
                  Installs v{data.latest} on this machine and restarts the app. Your keys and trade
                  history are not touched.
                </p>
                <button
                  type="button"
                  className="btn btn-primary self-start"
                  disabled={runUpdate.isPending}
                  onClick={() => runUpdate.mutate()}
                >
                  {runUpdate.isPending
                    ? 'Starting…'
                    : packageReady
                      ? 'Restart to update'
                      : `Update to v${data.latest}`}
                </button>
              </div>
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
