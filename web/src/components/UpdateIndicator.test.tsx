import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { RunUpdateResponse } from '../api/types';
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
      env<RunUpdateResponse>({ started: true, logPath: '/Users/x/.boros-crossex/logs/update.log' }),
    );
  });
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

  it('shows the pill for a newer version; the modal carries highlights and ONE OS command', async () => {
    await openModal({ current: '1.0.0', highlights: ['A brand new thing', 'Another improvement'] });

    expect(screen.getByText('Update available — v1.2.0')).toBeInTheDocument();
    expect(screen.getByText(/You're on/)).toHaveTextContent('v1.0.0');
    expect(screen.getByText('A brand new thing')).toBeInTheDocument();
    expect(screen.getByText('Another improvement')).toBeInTheDocument();
    const shown = [INSTALL_CMD, INSTALL_CMD_WINDOWS].filter((c) => screen.queryByText(c) !== null);
    expect(shown).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Full changelog/ })).toHaveAttribute(
      'href',
      'https://github.com/pendle-finance/arbitrage-with-crossex/blob/main/CHANGELOG.md',
    );
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

  it('the button runs the update once and names the log file', async () => {
    const calls: unknown[] = [];
    server.use(updateHandler(calls));
    await openModal();

    fireEvent.click(screen.getByRole('button', { name: 'Update to v1.2.0' }));
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent('/Users/x/.boros-crossex/logs/update.log');
    expect(note).toHaveTextContent(/comes back on its own/);
    expect(calls).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Update to/ })).toBeNull();
  });

  it('a refusal shows the server’s own reason and leaves the button usable', async () => {
    const calls: unknown[] = [];
    server.use(updateHandler(calls, 'a deal is still working — wait for it to finish before updating'));
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

  it('the modal closes', async () => {
    await openModal();
    expect(screen.getByText('Update available — v1.2.0')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Update available — v1.2.0')).toBeNull();
  });
});
