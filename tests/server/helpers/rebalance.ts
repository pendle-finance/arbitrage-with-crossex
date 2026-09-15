export async function waitFor(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const asset = (coin: string, venue: string, over: Record<string, string> = {}) => ({
  coin,
  exchange_type: venue,
  balance: '0',
  upnl: '0',
  equity: '0',
  liability: '0',
  borrowing_initial_margin: '0',
  borrowing_maintenance_margin: '0',
  ...over,
});

export const accountA = {
  user_id: '1',
  available_margin: '28.04',
  margin_balance: '57.45',
  initial_margin: '29.41',
  account_mode: 'CROSS_EXCHANGE',
  assets: [
    asset('USDT', 'CROSSEX', { balance: '92.54', available_balance: '92.54', equity: '92.54' }),
    asset('USDC', 'HYPERLIQUID', {
      balance: '-147.05',
      equity: '-147.05',
      liability: '147.05',
      borrowing_initial_margin: '29.41',
      borrowing_maintenance_margin: '14.71',
    }),
    asset('USDC', 'GATE', { balance: '111.96', available_balance: '111.96', equity: '111.96' }),
  ],
};
