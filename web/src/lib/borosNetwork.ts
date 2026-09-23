/** The Boros deployment the terminal talks to: the API host, and the chain and
 * Router the agent signature is bound to. Both are part of the EIP-712 domain,
 * so a wrong value yields a signature the contract rejects. */
export const BOROS_NETWORK = {
  apiBase: 'https://api-boros.pendle.finance/apis',
  chainId: 42161,
  routerAddress: '0x8080808080daB95eFED788a9214e400ba552DEf6',
} as const;
