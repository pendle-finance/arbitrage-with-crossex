/**
 * Delegated-agent provisioning for Boros — no `@pendle/boros-sdk-public`.
 *
 * Two steps, and only ONE wallet prompt:
 *
 *   1. Mint an agent keypair locally, from the browser's CSPRNG.
 *   2. Have the ROOT wallet EIP-712-sign an `ApproveAgentMessage` and encode it
 *      into the router's relayable `approveAgent(req, signature)` overload. The
 *      local server POSTs that to `/v1/send-txs/approve`, where Pendle's bot
 *      submits it and pays the gas, so the user needs no ETH on Arbitrum.
 *
 * ⚠ THE KEY IS RANDOM, not derived from a wallet signature. The SDK derived it
 * from a signed "welcome message", which reads like a recoverable derivation
 * but is not: that message embeds a timestamp and a random nonce, so re-running
 * setup produced a different key anyway. A CSPRNG key is the same strength,
 * costs one fewer wallet popup, and cannot be reconstructed by anyone who
 * phishes a signature out of the user later.
 *
 * The generated key never leaves this machine: it goes from here to the local
 * server and nowhere else. It is not logged, not put in a URL, not rendered.
 */
import { BOROS_NETWORK } from './borosNetwork';
import { encodeFunctionData, toHex, type Address, type Hex, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Arbitrum One, and the router the approval is bound to. Both are part of the
 * EIP-712 domain, so a wrong value yields a signature the contract rejects
 * rather than an approval that silently does the wrong thing. */
const CHAIN_ID = BOROS_NETWORK.chainId;
const ROUTER_ADDRESS = BOROS_NETWORK.routerAddress;

const EIP712_DOMAIN = {
  name: 'Pendle Boros Router',
  version: '1.0',
  chainId: CHAIN_ID,
  verifyingContract: ROUTER_ADDRESS as Hex,
} as const;

/** The struct the root wallet signs. Field order and types are the contract's. */
const APPROVE_AGENT_TYPES = {
  ApproveAgentMessage: [
    { name: 'root', type: 'address' },
    { name: 'accountId', type: 'uint8' },
    { name: 'agent', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

/**
 * The RELAYABLE overload.
 *
 * ⚠ `approveAgent` is overloaded. The one-argument form
 * (`approveAgent(req)` with no nonce) requires `msg.sender` to BE the root, so
 * the user would have to send the transaction and pay gas themselves. Only this
 * two-argument form carries the root's signature inside the calldata, which is
 * what lets Pendle's bot submit it on their behalf.
 */
const APPROVE_AGENT_ABI = [
  {
    type: 'function',
    name: 'approveAgent',
    stateMutability: 'nonpayable',
    outputs: [],
    inputs: [
      {
        type: 'tuple',
        name: 'req',
        components: [
          { name: 'root', type: 'address' },
          { name: 'accountId', type: 'uint8' },
          { name: 'agent', type: 'address' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
  },
] as const;

export interface GeneratedAgent {
  privateKey: Hex;
  address: Address;
}

/** A fresh agent keypair from the browser's CSPRNG. */
export function generateAgentKey(): GeneratedAgent {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const privateKey = toHex(bytes) as Hex;
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

/**
 * A nonce the router will accept.
 *
 * The contract wants one strictly above the root's last used `signerNonce`,
 * and the SDK took `max(signerNonce + 1, Date.now() * 1000)`. The clock term
 * always wins in practice — a microsecond timestamp is ~1.8e15 while the
 * counter only ever advances to a previously-used timestamp — and it stays
 * monotonic across approvals without an RPC round-trip, so it is used alone
 * rather than adding a public-RPC dependency (and its CORS and rate limits) to
 * a one-time flow.
 */
const approvalNonce = (): bigint => BigInt(Date.now()) * 1000n;

export interface ApproveAgentInput {
  walletClient: WalletClient;
  /** The account being delegated — the connected wallet's address. */
  root: Address;
  accountId?: number;
  /** The agent address from `generateAgentKey`. */
  agentAddress: Address;
  /** ABSOLUTE unix seconds. ⚠ Not a duration: the contract stores it verbatim,
   * so a duration approves the agent until 1971 and every later order fails
   * with `AuthAgentExpired()`. */
  expiry: number;
}

/**
 * Have the root wallet sign the agent's approval, and return the router call
 * that carries it. The local server sends it to Pendle's relayer.
 *
 * What protects the user is the signature itself: it commits to this exact
 * message under the router's EIP-712 domain, so calldata that does not match
 * is rejected rather than approving something else.
 */
export async function signAgentApproval(input: ApproveAgentInput): Promise<Hex> {
  const accountId = input.accountId ?? 0;
  const message = {
    root: input.root,
    accountId,
    agent: input.agentAddress,
    expiry: BigInt(input.expiry),
    nonce: approvalNonce(),
  };
  const account = input.walletClient.account ?? input.root;
  const signature = await input.walletClient.signTypedData({
    account: account as never,
    domain: EIP712_DOMAIN,
    types: APPROVE_AGENT_TYPES,
    primaryType: 'ApproveAgentMessage',
    message,
  });
  return encodeFunctionData({
    abi: APPROVE_AGENT_ABI,
    functionName: 'approveAgent',
    args: [message, signature],
  });
}
