/**
 * Browser wallet connection, over the raw EIP-1193 provider.
 *
 * Deliberately NO wagmi / RainbowKit / WalletConnect. This tool runs on the
 * user's own machine against their own accounts, and the wallet is needed for
 * exactly one thing — a single approval transaction, once — so a connector
 * framework and a relay service would be a large dependency and a new remote
 * host for a one-off. `window.ethereum` covers every injected wallet
 * (MetaMask, Rabby, Frame, Brave) and viem is already here via the Boros SDK.
 *
 * Nothing in this module signs an order, and nothing stores a key. It connects,
 * checks the chain, and hands back a viem WalletClient.
 */
import { t } from '../i18n';
import { createWalletClient, custom, type Address, type WalletClient } from 'viem';
import { arbitrum } from 'viem/chains';

/** Boros lives on Arbitrum One. */
export const BOROS_CHAIN = arbitrum;
export const BOROS_CHAIN_ID_HEX = `0x${arbitrum.id.toString(16)}`;

/** The slice of EIP-1193 we use. */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export class WalletError extends Error {
  readonly code: 'no-wallet' | 'rejected' | 'wrong-chain' | 'failed';
  constructor(code: WalletError['code'], message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

export const hasInjectedWallet = (): boolean =>
  typeof window !== 'undefined' && Boolean(window.ethereum);

/** EIP-1193 user-rejection. 4001 is the standard code; wallets vary in wording. */
function isUserRejection(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return (
    e?.code === 4001 ||
    e?.code === 'ACTION_REJECTED' ||
    /user rejected|user denied|rejected the request/i.test(e?.message ?? '')
  );
}

const ACCOUNT_READ_TIMEOUT_MS = 3_000;

export async function readWalletAccount(): Promise<string | null> {
  const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
  if (!provider) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ACCOUNT_READ_TIMEOUT_MS);
  });
  try {
    const accounts = await Promise.race([provider.request({ method: 'eth_accounts' }), timeout]);
    const first = Array.isArray(accounts) ? accounts[0] : undefined;
    return typeof first === 'string' && first ? first.toLowerCase() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function watchWalletAccount(onAccount: (address: string) => void): () => void {
  const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
  if (!provider?.on) return () => {};
  const handler = (...args: unknown[]) => {
    const accounts = args[0];
    const first = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof first === 'string' && first) onAccount(first.toLowerCase());
  };
  provider.on('accountsChanged', handler);
  return () => provider.removeListener?.('accountsChanged', handler);
}

export interface ConnectedWallet {
  address: Address;
  chainId: number;
  client: WalletClient;
}

/**
 * Prompt for accounts and return a wallet client on Arbitrum One.
 *
 * The chain is checked and, if wrong, a switch is REQUESTED rather than
 * assumed: signing an approval meant for Arbitrum while the wallet points
 * somewhere else either fails confusingly or approves on a chain Boros does not
 * read. `4902` means the chain is unknown to the wallet, so it is added first.
 */
/** Prompt for the wallet's account, and nothing else: no chain switch and no
 * signature. Connecting only picks which account the terminal shows. */
export async function requestWalletAccount(): Promise<Address> {
  const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
  if (!provider) {
    throw new WalletError(
      'no-wallet',
      t('app.walletError.noWallet'),
    );
  }

  let accounts: string[];
  try {
    accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  } catch (err) {
    if (isUserRejection(err)) {
      throw new WalletError('rejected', t('app.walletError.rejected'));
    }
    throw new WalletError('failed', (err as Error)?.message ?? t('app.walletError.connectFailed'));
  }
  const address = accounts?.[0] as Address | undefined;
  if (!address) throw new WalletError('failed', t('app.walletError.noAccount'));
  return address;
}

export async function connectWallet(): Promise<ConnectedWallet> {
  const address = await requestWalletAccount();
  const provider = window.ethereum!;

  const chainId = Number(await provider.request({ method: 'eth_chainId' }));
  if (chainId !== BOROS_CHAIN.id) {
    await switchToBorosChain(provider);
  }

  return {
    address,
    chainId: BOROS_CHAIN.id,
    client: createWalletClient({ account: address, chain: BOROS_CHAIN, transport: custom(provider) }),
  };
}

async function switchToBorosChain(provider: Eip1193Provider): Promise<void> {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BOROS_CHAIN_ID_HEX }],
    });
    return;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (isUserRejection(err)) {
      throw new WalletError('wrong-chain', t('app.walletError.switchRejected', { chain: BOROS_CHAIN.name }));
    }
    // 4902: the wallet does not know this chain yet.
    if (code !== 4902) {
      throw new WalletError('wrong-chain', t('app.walletError.switchManually', { chain: BOROS_CHAIN.name }));
    }
  }

  try {
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: BOROS_CHAIN_ID_HEX,
          chainName: BOROS_CHAIN.name,
          nativeCurrency: BOROS_CHAIN.nativeCurrency,
          rpcUrls: [...BOROS_CHAIN.rpcUrls.default.http],
          blockExplorerUrls: [BOROS_CHAIN.blockExplorers?.default.url].filter(Boolean),
        },
      ],
    });
  } catch (err) {
    if (isUserRejection(err)) {
      throw new WalletError('wrong-chain', t('app.walletError.addRejected', { chain: BOROS_CHAIN.name }));
    }
    throw new WalletError('wrong-chain', t('app.walletError.switchFailed', { chain: BOROS_CHAIN.name }));
  }
}

/** Turn any wallet/SDK throw into a sentence worth showing. */
export function describeWalletError(err: unknown): string {
  if (err instanceof WalletError) return err.message;
  if (isUserRejection(err)) return t('app.walletError.userRejected');
  return (err as Error)?.message ?? t('app.walletError.requestFailed');
}
