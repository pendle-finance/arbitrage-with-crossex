# Translation guide

The terminal's copy lives in `en/*.json`, one file per screen area. Each other
language is a folder with the same files and keys. `locales.test.ts` fails when
a key, a `{{placeholder}}` or a `<tag>` is missing in any language, and when a
screen file has English typed straight into it.

## Fix a translation

Edit the line in `zh-CN/<area>.json`. Nothing else changes.

## Add a language

1. Copy `en/` to `<code>/` (for example `zh-TW/`) and translate the values.
2. Import it in `i18n/index.ts` and add it to `resources`.
3. Add a row to `LANGUAGES` in `i18n/languages.ts`.

## Add a line of copy

1. Add the key to `en/<area>.json` and to every other language.
2. In a component: `const { t } = useTranslation();` then `t('area.key', { size })`.
   Outside React: `import { t } from '../i18n'`.
3. A sentence with numbers or names is one key with placeholders, never pieces
   glued together: Chinese puts the words in another order.
   `"heldTwice": "{{held}} This open covers {{size}} twice until {{date}}."`
4. Bold text or a link inside a sentence: `<Trans i18nKey="area.key" components={{ b: <b /> }} />`
   with `"key": "Close <b>{{size}}</b> first."`.
5. Counts: `t('area.legs', { count })` with `legs_one` and `legs_other` in English.
   Chinese has one form: `legs_other` only.
6. Dates go through `fmtDateShort`, which prints `30 Oct` or `10月30日` by language.
   Never type a month name.

## Words that stay as they are

Boros, CrossEx, Pendle, venue names (Gate, Hyperliquid, Binance, Lighter, OKX,
Bybit), coin tickers (ETH, BTC, USDT, USDC), YU, APR, Gas, IOC, API, Telegram.

## Simplified Chinese terms

These follow the Boros app's Chinese (`dapp-nitro/src/locales/cn`), so a trader
reads the same word in both apps.

| English | 简体中文 |
|---|---|
| funding rate | 资金费率 |
| perp, perpetual | 永续合约 (tight space: 永续) |
| Long / Short (side, tag) | 多头 / 空头 |
| go long / go short (action) | 做多 / 做空 |
| leg | 腿 |
| pair (a hedged Boros + perp pair) | 组合 |
| Fixed Rate Pairs | 固定利率组合 |
| fixed rate, fixed APR | 固定利率, 固定 APR |
| implied APR | 隐含 APR |
| underlying APR | 标的 APR |
| spread (Boros spread market) | 利差 |
| maturity, matures | 到期 |
| matured | 已到期 |
| roll over | 展期 |
| hedge, hedged | 对冲, 已对冲 |
| delta-neutral | Delta 中性 |
| arbitrage | 套利 |
| opportunity | 机会 |
| position | 仓位 (list of them: 持仓) |
| open a position | 开仓 |
| close a position | 平仓 |
| size | 规模 (an amount of coin: 数量) |
| notional | 名义规模 |
| capital | 资金 |
| margin | 保证金 |
| cross margin / isolated margin | 全仓保证金 / 逐仓保证金 |
| maintenance margin | 维持保证金 |
| collateral | 抵押品 |
| equity | 权益 |
| balance | 余额 |
| liquidation, liquidation price | 清算, 清算价格 |
| unrealized PnL / realized PnL | 未实现盈亏 / 已实现盈亏 |
| PnL | 盈亏 |
| fee / trading fee | 手续费 / 交易手续费 |
| settlement | 结算 |
| rebate | 返佣 |
| order, limit order, market order | 订单, 限价单, 市价单 |
| filled, part filled | 已成交, 部分成交 |
| slippage | 滑点 |
| leverage | 杠杆 |
| borrow, interest | 借款, 利息 |
| spot | 现货 |
| transfer (between wallets) | 划转 |
| rebalance | 再平衡 |
| top up | 充值 |
| withdraw | 提款 |
| wallet | 钱包 |
| agent (Boros signing key) | 代理 |
| API key | API 密钥 |
| ungrouped | 未分组 |

## Style

- Put a space between Chinese and a Latin word or a number: `固定 APR`, `4 ETH 重复对冲`.
- Use full-width punctuation inside Chinese sentences: `，。：（）`.
- Keep trader words short. A tag or button stays as short as the English one.
- Leave out "you" where the sentence works without it. Use 您 when it is needed.
