import { vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

export function installFakeWallet(opts: { accounts?: string[]; ethAccounts?: () => Promise<unknown> } = {}) {
  const listeners = new Map<string, Set<Handler>>();
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_accounts') return opts.ethAccounts ? opts.ethAccounts() : (opts.accounts ?? []);
    if (method === 'eth_requestAccounts') return opts.accounts ?? [];
    if (method === 'eth_chainId') return '0xa4b1';
    return null;
  });
  const provider = {
    request,
    on: (event: string, handler: Handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeListener: (event: string, handler: Handler) => listeners.get(event)?.delete(handler),
  };
  (window as unknown as { ethereum?: unknown }).ethereum = provider;
  return {
    request,
    emitAccounts: (accounts: string[]) => listeners.get('accountsChanged')?.forEach((h) => h(accounts)),
    listenerCount: () => listeners.get('accountsChanged')?.size ?? 0,
    methods: () => request.mock.calls.map(([args]) => args.method),
  };
}

export function removeFakeWallet() {
  delete (window as unknown as { ethereum?: unknown }).ethereum;
}
