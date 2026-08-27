import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunUpdateResponse, UpdateProgress, UpdateStatus } from '../api/types';
import { INSTALL_CMD, INSTALL_CMD_WINDOWS } from '../lib/app';
import { versionHandler } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { UpdateIndicator } from './UpdateIndicator';

function updateHandler(calls: unknown[], refusal?: string) {
  return http.post('/api/version/update', () => {
    calls.push(Date.now());
    if (refusal !== undefined) {
      return HttpResponse.json(
        { ok: false, error: { category: 'validation', message: refusal, retryable: true } },
        { status: 409 },
      );
    }
    return HttpResponse.json(
      env<RunUpdateResponse>({
        started: true,
        logPath: '/Users/x/.boros-crossex/logs/update.log',
      }),
    );
  });
}


/** The installer's output. Polled the moment an update starts, so every test
 * that presses the button needs one — msw is set to error on a stray request. */
function logHandler(text = '') {
  return http.get('/api/version/update/log', () =>
    HttpResponse.json(env<UpdateProgress>({ startedAt: Date.now(), running: true, text })),
  );
}

/** An install-info block, so a test can say which commit is being served. */
function installedAt(commit: string): UpdateStatus['install'] {
  return {
    repo: 'pendle-finance/arbitrage-with-crossex',
    requestedRef: 'refs/heads/main',
    commit,
    source: 'github-archive',
    installedAt: '2026-01-01T00:00:00Z',
  };
}

/** jsdom's own reload throws. Replace the whole object, and put it back after
 * — a leaked stub would silently disarm navigation in every later test. */
function stubReload() {
  const real = window.location;
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...real, reload },
  });
  return {
    reload,
    restore: () => Object.defineProperty(window, 'location', { configurable: true, value: real }),
  };
}

async function openModal(over: Parameters<typeof versionHandler>[0] = {}) {
  server.use(versionHandler({ latest: '1.2.0', updateAvailable: true, ...over }));
  renderWithClient(<UpdateIndicator />);
  fireEvent.click(await screen.findByRole('button', { name: 'Update v1.2.0' }));
}

describe('UpdateIndicator', () => {
  it('renders nothing while up to date', async () => {
    server.use(versionHandler());
    renderWithClient(<UpdateIndicator />);
    // Give the query a beat to resolve, then assert absence.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /Update v/ })).toBeNull();
  });

  it('shows the pill for a newer version; the modal carries highlights and ONE button', async () => {
    await openModal({ current: '1.0.0', highlights: ['A brand new thing', 'Another improvement'] });

    expect(screen.getByText('Update available — v1.2.0')).toBeInTheDocument();
    expect(screen.getByText(/You’re on/)).toHaveTextContent('v1.0.0');
    expect(screen.getByText('A brand new thing')).toBeInTheDocument();
    expect(screen.getByText('Another improvement')).toBeInTheDocument();
    // The one-click route is what opens, so the only thing to press is the
    // update itself — no command block competing with it for the eye.
    expect(screen.getByRole('button', { name: 'Update to v1.2.0' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy command/ })).toBeNull();
    expect([INSTALL_CMD, INSTALL_CMD_WINDOWS].filter((c) => screen.queryByText(c))).toHaveLength(0);
    expect(screen.getByRole('link', { name: /Full changelog/ })).toHaveAttribute(
      'href',
      'https://github.com/pendle-finance/arbitrage-with-crossex/blob/main/CHANGELOG.md',
    );
  });

  it('hands back this machine’s command once the update has stopped', async () => {
    server.use(
      updateHandler([]),
      logHandler('      the previous version is running again at http://localhost:6688'),
    );
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: 'Update to v1.2.0' }));

    // There is no platform toggle any more, so the failure has one command to
    // offer and it has to pick. jsdom's UA is not Windows, so macOS is it.
    const panel = await screen.findByRole('status');
    await waitFor(() => expect(within(panel).getByText(INSTALL_CMD)).toBeInTheDocument());
    expect(screen.queryByText(INSTALL_CMD_WINDOWS)).toBeNull();
  });

  it('links the diff from the installed commit', async () => {
    await openModal({
      install: {
        repo: 'pendle-finance/arbitrage-with-crossex',
        requestedRef: 'main',
        commit: 'abc1234',
        source: 'install.sh',
        installedAt: '2026-08-01T00:00:00Z',
      },
    });
    expect(screen.getByRole('link', { name: /code changes/ })).toHaveAttribute(
      'href',
      'https://github.com/pendle-finance/arbitrage-with-crossex/compare/abc1234...main',
    );
  });

  it('falls back to the commit list in a source checkout', async () => {
    await openModal();
    expect(screen.getByRole('link', { name: /code changes/ })).toHaveAttribute(
      'href',
      'https://github.com/pendle-finance/arbitrage-with-crossex/commits/main',
    );
  });

  it('pins the diff link to the advertised commit, and keeps shas out of the dialog', async () => {
    const sha = '3f7c1b9e2d4a6058cbe1740f9a2d5b83c6e0f1a4';
    await openModal({
      latestCommit: sha,
      install: {
        repo: 'pendle-finance/arbitrage-with-crossex',
        requestedRef: 'main',
        commit: 'abc1234',
        source: 'install.sh',
        installedAt: '2026-08-01T00:00:00Z',
      },
    });

    expect(screen.getByRole('link', { name: /code changes/ })).toHaveAttribute(
      'href',
      `https://github.com/pendle-finance/arbitrage-with-crossex/compare/abc1234...${sha}`,
    );
    // The sha belongs in that link and nowhere else. Printed in the dialog it
    // is a 40-character string to check by eye against a link that already
    // shows the same thing — and the one-click install pins itself to the
    // release tag, not to a ref the dialog hands it.
    expect(screen.queryByText(new RegExp(sha))).toBeNull();
  });

  it('the button runs the update once, then shows one line while it installs', async () => {
    const calls: unknown[] = [];
    server.use(updateHandler(calls), logHandler('==> Installing dependencies (this takes a minute)…'));
    await openModal();

    fireEvent.click(screen.getByRole('button', { name: 'Update to v1.2.0' }));
    const panel = await screen.findByRole('status');
    expect(panel).toHaveTextContent('Installing v1.2.0. This page reloads itself when it is done.');
    expect(calls).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull();

    // The installer's own steps stay out of a running update: a fast install
    // prints none of them, so a checklist built from them reads as skipped work.
    await new Promise((r) => setTimeout(r, 30));
    expect(panel).not.toHaveTextContent('Installing dependencies');
    expect(within(panel).queryByText('Show log')).toBeNull();
  });

  it('says an update failed rather than spinning, and offers another go', async () => {
    const calls: unknown[] = [];
    server.use(
      updateHandler(calls),
      logHandler(
        ['==> Building the web interface…', 'Error: build failed',
         '      the previous version is running again at http://localhost:6688'].join('\n'),
      ),
    );
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: 'Update to v1.2.0' }));

    const panel = await screen.findByRole('status');
    await waitFor(() => expect(panel).toHaveTextContent('The update failed'));
    expect(panel).toHaveTextContent('Your keys and trade history are untouched');
    expect(within(panel).getByText('Show log')).toBeInTheDocument();
    expect(panel).toHaveTextContent('/Users/x/.boros-crossex/logs/update.log');

    fireEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Update to v1.2.0' })).toBeEnabled();
  });

  it('reads “Restart to update” when the package is already staged', async () => {
    await openModal({ packageReady: true });
    expect(screen.getByRole('button', { name: 'Restart to update' })).toBeInTheDocument();
  });

  it('flips to “Restart to update” when the package lands, past the six-hour cache', async () => {
    // /version is cached for six hours, so the first answer — package not
    // ready — is the only one the page itself ever sees. The install watch is
    // what learns the download finished, and it polls every 2.5 seconds.
    await openModal({ packageReady: false });
    expect(screen.getByRole('button', { name: 'Update to v1.2.0' })).toBeInTheDocument();

    server.use(versionHandler({ latest: '1.2.0', updateAvailable: true, packageReady: true }));
    expect(
      await screen.findByRole('button', { name: 'Restart to update' }, { timeout: 6000 }),
    ).toBeInTheDocument();
  }, 9000);

  it('a refusal shows the server’s own reason and leaves the button usable', async () => {
    const calls: unknown[] = [];
    server.use(
      updateHandler(calls, 'a deal is still working — wait for it to finish before updating'),
      logHandler(),
    );
    await openModal();

    fireEvent.click(screen.getByRole('button', { name: 'Update to v1.2.0' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('a deal is still working');
    const button = screen.getByRole('button', { name: 'Update to v1.2.0' });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it('the modal escapes its render site — portaled to <body>', async () => {
    // The pill lives inside the sticky blurred header; without the portal the
    // header's backdrop-filter contains the fixed overlay and the modal opens
    // half-hidden behind the page content.
    await openModal();
    expect(screen.getByRole('dialog').parentElement).toBe(document.body);
  });

  describe('after the install lands', () => {
    let stub: ReturnType<typeof stubReload> | null = null;
    afterEach(() => {
      stub?.restore();
      stub = null;
    });

    it('reloads once the server is serving a different commit', async () => {
      stub = stubReload();
      const calls: unknown[] = [];
      // The page's own /version answer is cached for six hours, so it keeps
      // reporting the OLD commit. The watch is what sees the swap — and it is
      // already running before the click, staging the package, so the new
      // commit arrives on its next 2.5-second poll rather than at once.
      server.use(
        versionHandler({ latest: '1.2.0', updateAvailable: true, install: installedAt('a'.repeat(40)) }),
        updateHandler(calls),
        logHandler(),
      );
      renderWithClient(<UpdateIndicator />);
      fireEvent.click(await screen.findByRole('button', { name: 'Update v1.2.0' }));

      server.use(
        versionHandler({ latest: '1.2.0', updateAvailable: true, install: installedAt('b'.repeat(40)) }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Update to v1.2.0' }));

      await waitFor(() => expect(stub!.reload).toHaveBeenCalled(), { timeout: 6000 });
    }, 9000);

    it('keeps watching while the tab is hidden, which is where an update spends its minute', async () => {
      // Nobody watches a progress line for a minute. React Query pauses a
      // plain interval on a hidden tab, so without refetchIntervalInBackground
      // the watch fetches once and the page never learns about the swap.
      stub = stubReload();
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

      let served = 0;
      const calls: unknown[] = [];
      server.use(
        http.get('/api/version', () => {
          served += 1;
          // The first two answers are the OLD commit: the swap has not
          // happened yet. Only a later poll can see the new one.
          return HttpResponse.json(
            env<UpdateStatus>({
              current: '1.0.0',
              install: installedAt((served <= 2 ? 'a' : 'b').repeat(40)),
              latest: '1.2.0',
              latestCommit: null,
              updateAvailable: true,
              packageReady: false,
              highlights: [],
            }),
          );
        }),
        updateHandler(calls),
        logHandler(),
      );
      renderWithClient(<UpdateIndicator />);
      fireEvent.click(await screen.findByRole('button', { name: 'Update v1.2.0' }));
      fireEvent.click(screen.getByRole('button', { name: 'Update to v1.2.0' }));

      await waitFor(() => expect(stub!.reload).toHaveBeenCalled(), { timeout: 9000 });
    }, 12000);

    it('does not reload while the same commit is still serving', async () => {
      stub = stubReload();
      const calls: unknown[] = [];
      server.use(
        versionHandler({ latest: '1.2.0', updateAvailable: true, install: installedAt('a'.repeat(40)) }),
        updateHandler(calls),
        logHandler(),
      );
      renderWithClient(<UpdateIndicator />);
      fireEvent.click(await screen.findByRole('button', { name: 'Update v1.2.0' }));
      fireEvent.click(screen.getByRole('button', { name: 'Update to v1.2.0' }));

      await screen.findByRole('status');
      expect(stub!.reload).not.toHaveBeenCalled();
    });

    it('never watches before the update is asked for', async () => {
      stub = stubReload();
      // A page that merely SEES an update available must not reload, even
      // though the server it polls could be a different install.
      server.use(
        versionHandler({ latest: '1.2.0', updateAvailable: true, install: installedAt('a'.repeat(40)) }),
      );
      renderWithClient(<UpdateIndicator />);
      await screen.findByRole('button', { name: 'Update v1.2.0' });

      server.use(
        versionHandler({ latest: '1.2.0', updateAvailable: true, install: installedAt('b'.repeat(40)) }),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(stub!.reload).not.toHaveBeenCalled();
    });
  });

  it('the modal closes', async () => {
    await openModal();
    expect(screen.getByText('Update available — v1.2.0')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Update available — v1.2.0')).toBeNull();
  });
});
