import { privateKeyToAccount } from 'viem/accounts';

export interface WalletProof {
  wallet: string;
  agent: string;
  signedAt: number;
  signature: string;
}

export const walletProofMessage = (keyHash: string, wallet: string, signedAt: number): string =>
  `CrossEx terminal ${keyHash} follows ${wallet} at ${signedAt}`;

export async function signWalletProof(opts: {
  keyHash: string;
  wallet: string;
  agentPrivateKey: `0x${string}`;
  nowMs: number;
}): Promise<WalletProof> {
  const account = privateKeyToAccount(opts.agentPrivateKey);
  const wallet = opts.wallet.toLowerCase();
  const signedAt = Math.floor(opts.nowMs / 1000);
  const signature = await account.signMessage({ message: walletProofMessage(opts.keyHash, wallet, signedAt) });
  return { wallet, agent: account.address.toLowerCase(), signedAt, signature };
}
