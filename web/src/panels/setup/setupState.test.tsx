import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { agentStatus, mockWorld } from '../../test/fixtures';
import { TrackedAddressProvider } from '../trackedAddress';
import { useSetupState } from './setupState';

const WALLET = `0xab18${'0'.repeat(32)}ed9d`;

function hookWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TrackedAddressProvider>{children}</TrackedAddressProvider>
    </QueryClientProvider>
  );
  return wrapper;
}

describe('useSetupState', () => {
  it('an expired approval is not done', async () => {
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET, expired: true }) });
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.borosWallet).toBe('missing');
    expect(result.current.doneCount).toBe(1);
  });

  it('an expired approval is not done while its wallet is tracked', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: WALLET }));
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET, expired: true }) });
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.borosWallet).toBe('missing');
    expect(result.current.firstMissing).toBe('borosWallet');
  });

  it('a tracked address with no approval is done', async () => {
    localStorage.setItem('crossex.strategy.v1', JSON.stringify({ address: WALLET }));
    mockWorld({ keyConfigured: true });
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.borosWallet).toBe('done');
  });

  it('a live approval is done', async () => {
    mockWorld({ keyConfigured: true, agent: agentStatus({ configured: true, root: WALLET, expired: false }) });
    const { result } = renderHook(() => useSetupState(), { wrapper: hookWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.steps.borosWallet).toBe('done');
    expect(result.current.doneCount).toBe(2);
  });
});
