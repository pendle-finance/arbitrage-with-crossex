import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { ActiveWalletChip } from './ActiveWalletChip';

const ROOT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x3333333333333333333333333333333333333333';
const env = <T,>(data: T) => ({ ok: true, data, meta: { ts: Date.now() } });
const nowSec = () => Math.floor(Date.now() / 1000);

const show = (active: string, agent: Record<string, unknown>) => {
  localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: active, walletUpgraded: true }));
  server.use(
    http.get('/api/boros/agent', () =>
      HttpResponse.json(
        env({ configured: true, root: ROOT, rootMasked: '0x1111…1111', accountId: 0, expiry: null, expired: false, canProvision: true, ...agent }),
      ),
    ),
  );
  renderWithClient(<ActiveWalletChip />);
};

afterEach(() => localStorage.clear());

describe('ActiveWalletChip', () => {
  it('logged-in wallet: "Can trade"', async () => {
    show(ROOT, { approval: 'approved', expiry: nowSec() + 200 * 86400 });
    expect(await screen.findByText('Can trade')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('0x1111…1111');
  });

  it('another wallet: "View only"', async () => {
    show(OTHER, { approval: 'approved' });
    expect(await screen.findByText('View only')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveTextContent('0x3333…3333');
  });

  it('a key the chain never approved: "Not approved", never "Can trade"', async () => {
    show(ROOT, { approval: 'not-approved', expiry: nowSec() + 300 * 86400 });
    expect(await screen.findByText('Not approved')).toBeInTheDocument();
    expect(screen.queryByText('Can trade')).toBeNull();
  });

  it('an ended login: "Login expired"', async () => {
    show(ROOT, { approval: 'expired', expired: true, expiry: nowSec() - 60 });
    expect(await screen.findByText('Login expired')).toBeInTheDocument();
  });

  it('a login ending within 14 days: "Renew by …"', async () => {
    show(ROOT, { approval: 'approved', expiry: nowSec() + 3 * 86400 });
    expect(await screen.findByText(/^Renew by /)).toBeInTheDocument();
  });
});
