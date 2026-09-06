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
        ref: null,
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

/** The install command lives behind the second route now — the dialog opens on
 * the one-click one. */
const manualRoute = () => fireEvent.click(screen.getByRole('radio', { name: 'Run it in my terminal' }));

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

  it('puts the command behind the second route, this machine selected', async () => {
    // jsdom's UA is not Windows, so macOS is the one already chosen.
    await openModal();
    manualRoute();
    expect(screen.getByRole('radio', { name: 'macOS' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(INSTALL_CMD)).toBeInTheDocument();
    // One thing to press on this route too.
    expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Windows' }));
    expect(screen.getByText(INSTALL_CMD_WINDOWS)).toBeInTheDocument();
    expect(screen.queryByText(INSTALL_CMD)).toBeNull();
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
    // The command the user pastes is the one on the landing page and in the
    // README. A 40-character ref in front of it is a sha to check against a
    // link that already shows the same thing — and the server pins the
    // one-click install to that commit either way.
    manualRoute();
    expect(screen.getByText(INSTALL_CMD)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(sha))).toBeNull();
  });

  it('the button runs the update once, then shows what the installer is doing', async () => {
    const calls: unknown[] = [];
    server.use(updateHandler(calls), logHandler('==> Installing dependencies (this takes a minute)…'));
    await openModal();

    fireEvent.click(screen.getByRole('button', { name: 'Update to v1.2.0' }));
    const panel = await screen.findByRole('status');
    expect(panel).toHaveTextContent('Installation running in the background.');
    expect(calls).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull();

    // The step the installer named, and the checklist caught up to it.
    await waitFor(() => expect(panel).toHaveTextContent('Installing dependencies'));
    expect(panel).toHaveTextContent('/Users/x/.boros-crossex/logs/update.log');
    expect(within(panel).getAllByRole('listitem')[1]).toHaveTextContent('✓Download');
    expect(within(panel).getAllByRole('listitem')[2]).toHaveTextContent('●Dependencies');
    expect(within(panel).getAllByRole('listitem')[3]).toHaveTextContent('○Build');
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

    fireEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'Update to v1.2.0' })).toBeEnabled();
  });

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
      // reporting the OLD commit. The watch is what sees the swap.
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

      await waitFor(() => expect(stub!.reload).toHaveBeenCalled());
    });

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
