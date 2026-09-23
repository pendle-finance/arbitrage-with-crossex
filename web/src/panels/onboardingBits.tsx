import type { ReactNode } from 'react';

export const GATE_API_KEYS_URL = 'https://www.gate.com/myaccount/api_key_manage';
export const GATE_SIGNUP_URL = 'https://www.gate.com/signup';
export const GATE_CROSSEX_URL = 'https://www.gate.com/crossex';

export const PERMISSION_ROWS = [
  { on: true, label: 'Cross-Exchange', value: 'Read and Write', detail: 'trade and move money' },
  { on: true, label: 'Spot Trading', value: 'Read Only', detail: 'see spot balances' },
  { on: false, label: 'All others', value: 'Off', detail: 'including Withdrawal' },
] as const;

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200"
    >
      {children}
    </a>
  );
}
