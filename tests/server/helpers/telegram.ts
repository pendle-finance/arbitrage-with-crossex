import type { TriggerCoin } from '../../../src/core/alerts/triggers';
import type { FetchLike } from '../../../src/core/boros/client';
import { botBaseUrl, createBotClient, type TerminalView } from '../../../src/server/telegram/botClient';

export const BOT_URL = 'https://boros-bot-notification.pendle.finance';
export const CROSSEX = `${BOT_URL}/noti/boros/crossex`;

export const ETH: TriggerCoin = {
  coin: 'ETH',
  legs: [
    { venue: 'GATE', side: 'short' },
    { venue: 'HYPERLIQUID', side: 'long' },
  ],
  liquidation: { down: null, up: { price: 13_663, venue: 'GATE' } },
  interest: { down: { price: 1_612, wallet: 'USDT' }, up: { price: 19_470, wallet: 'HYPERLIQUID' } },
  rolls: [],
};

export const VIEW: TerminalView = {
  wallet: '0xabc',
  version: '1.6.3',
  connectedAt: '2026-09-18T00:00:00.000Z',
  lastSyncAt: null,
  port: 7788,
  settings: { liquidation: true, interest: true, maturity: true, rollover: true },
  coins: [],
};

export interface BotCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type BotAnswer = (call: BotCall) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

export function makeBotStub(answer: BotAnswer = async () => ({ status: 200, body: VIEW })) {
  const calls: BotCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: BotCall = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const res = await answer(call);
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.body };
  };
  return {
    calls,
    to: (method: string, route: string) => calls.filter((c) => c.method === method && c.url === `${CROSSEX}${route}`),
    bot: createBotClient({ baseUrl: botBaseUrl({}), fetchImpl }),
  };
}
