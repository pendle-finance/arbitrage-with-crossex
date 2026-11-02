import type { ReactNode } from 'react';
import { t } from '../i18n';

export const GATE_API_KEYS_URL = 'https://www.gate.com/myaccount/api_key_manage';
export const GATE_SIGNUP_URL = 'https://www.gate.com/signup';
export const GATE_CROSSEX_URL = 'https://www.gate.com/crossex';

export const PERMISSION_ROWS = [
  {
    on: true,
    get label() {
      return t('app.permissions.crossExchange');
    },
    get value() {
      return t('app.permissions.readWrite');
    },
    get detail() {
      return t('app.permissions.tradeTransfer');
    },
  },
  {
    on: true,
    get label() {
      return t('app.permissions.spot');
    },
    get value() {
      return t('app.permissions.readOnly');
    },
    get detail() {
      return t('app.permissions.spotBalances');
    },
  },
  {
    on: false,
    get label() {
      return t('app.permissions.others');
    },
    get value() {
      return t('app.permissions.off');
    },
    get detail() {
      return t('app.permissions.withdrawal');
    },
  },
] as const;

export function Ext({ href, children }: { href: string; children?: ReactNode }) {
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
