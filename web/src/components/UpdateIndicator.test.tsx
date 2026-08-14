/** The update pill renders ONLY when the server reports a newer published
 * version; the modal shows the highlights and both OS one-liners verbatim. */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { INSTALL_CMD, INSTALL_CMD_WINDOWS } from '../lib/landing';
import { versionHandler } from '../test/fixtures';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { UpdateIndicator } from './UpdateIndicator';

describe('UpdateIndicator', () => {
  it('renders nothing while up to date', async () => {
    server.use(versionHandler());
    renderWithClient(<UpdateIndicator />);
    // Give the query a beat to resolve, then assert absence.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /Update v/ })).toBeNull();
  });

  it('shows the pill for a newer version; the modal carries highlights and both OS commands', async () => {
    server.use(
      versionHandler({
        current: '1.0.0',
        latest: '1.2.0',
        updateAvailable: true,
        highlights: ['A brand new thing', 'Another improvement'],
      }),
    );
    renderWithClient(<UpdateIndicator />);

    const pill = await screen.findByRole('button', { name: 'Update v1.2.0' });
    fireEvent.click(pill);

    expect(screen.getByText('Update available — v1.2.0')).toBeInTheDocument();
    expect(screen.getByText(/You're on/)).toHaveTextContent('v1.0.0');
    expect(screen.getByText('A brand new thing')).toBeInTheDocument();
    expect(screen.getByText('Another improvement')).toBeInTheDocument();
    // Both platforms' commands, verbatim from the shared constants — the same
    // strings the README and landing page publish.
    expect(screen.getByText(INSTALL_CMD)).toBeInTheDocument();
    expect(screen.getByText(INSTALL_CMD_WINDOWS)).toBeInTheDocument();
    // jsdom's UA is neither macOS nor Windows-decorated consistently — just
    // assert exactly one section is tagged as this machine.
    expect(screen.getAllByText('(this machine)')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Full changelog/ })).toHaveAttribute(
      'href',
      'https://github.com/pendle-finance/crossex-boros-terminal/blob/main/CHANGELOG.md',
    );
  });

  it('the modal escapes its render site — portaled to <body>', async () => {
    // The pill lives inside the sticky blurred header; without the portal the
    // header's backdrop-filter contains the fixed overlay and the modal opens
    // half-hidden behind the page content.
    server.use(versionHandler({ latest: '1.2.0', updateAvailable: true }));
    renderWithClient(<UpdateIndicator />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update v1.2.0' }));
    expect(screen.getByRole('dialog').parentElement).toBe(document.body);
  });

  it('the modal closes', async () => {
    server.use(versionHandler({ latest: '1.2.0', updateAvailable: true }));
    renderWithClient(<UpdateIndicator />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update v1.2.0' }));
    expect(screen.getByText('Update available — v1.2.0')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Update available — v1.2.0')).toBeNull();
  });
});
