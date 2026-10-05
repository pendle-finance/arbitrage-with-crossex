# LTP dashboard integration

## Source and scope

Ported from `published-ltp` at `f824a9b` onto `main` at `02971e98`.
`ltp-opportunities` at `19d55cd` is the older page, before the leverage caps,
stacked mind map, and loading improvements.

This commit brings the existing pitch page, live opportunity calculation,
read-only API, and regression tests. It keeps main's current Boros API client,
trading implementation, authentication, and normal terminal build. It does not
include the PB letter, deployment configuration, LTP trading CLI, credentials,
private fee files, or a collateral-management bot. The bot diagram describes
what a strategy operator needs to build; it does not execute transfers.

## Preview in this repository

```sh
yarn install --frozen-lockfile
yarn --cwd web install --frozen-lockfile
yarn dev
# Open http://localhost:8711/ltp.html
```

The Vite proxy uses the backend's local API token, as it does for the terminal.
For a production-build check:

```sh
yarn --cwd web build:ltp
yarn server
# Open http://localhost:6688/ltp
```

`build:ltp` emits both the existing terminal and `ltp.html`. Ordinary `build`
and `start` still build only the terminal. The optional `/ltp` and `/ltp.html`
routes inject the local API token and send `Cache-Control: no-store`.
Nothing in this commit deploys a site or modifies the published branches.

## Embed in another dashboard

Mount `LtpLandingApp` under the host's `QueryClientProvider`:

```tsx
import { LtpLandingApp } from './LtpLandingApp';

// Inside the existing React Query provider and the dashboard's LTP route:
<LtpLandingApp />
```

The standalone `web/src/main-ltp.tsx` shows the provider setup. The page owns its
header, fixed assumption controls, localStorage preferences/last-scan seed,
and section hashes (`#live`, `#system`, `#risk`), so give it its own route.

| Responsibility | Files |
| --- | --- |
| Pitch page and diagrams | `web/src/LtpLandingApp.tsx`, `web/src/ltp-pitch.css` |
| Request, polling, and wire contract | `web/src/api/ltp.ts`, `web/src/api/ltpTypes.ts` |
| Profit and capital charts | `web/src/panels/LtpOpportunityWaterfall.tsx`, shared `components/Waterfall.tsx` |
| Formatting and preferences | Shared `lib/fmt.ts`, `lib/storage.ts`, `lib/useDebounced.ts` |
| HTTP transport/auth | Shared `web/src/api/client.ts` |
| Calculation and fees | `src/core/ltp/opportunities.ts`, `feeTiers.ts`, `hlCaps.ts` |
| API/data orchestration | `src/server/routes/opportunitiesLtp.ts` |

Keep the existing Tailwind setup and shared styles (the waterfall uses utility
classes); the pitch-specific rules are scoped to `.lp-*`. `ltp.html` specifies
Inter and JetBrains Mono. A different dashboard can supply those fonts itself.
Adapt `fetchJson` if the host uses a different API prefix or authentication.
The new query hook does not import the terminal's trading/account hooks.

## Backend contract

`buildApp` already registers `GET /api/opportunities-ltp`. In another Fastify
host, register `opportunitiesLtpRoutes(deps)` with the `/api` prefix and retain
the host's authentication, error handler and `{ok,data,meta}` response envelope
(the plugin uses `reply.ok`). Its dependencies are a `TtlCache`, optional
`borosFetch`, optional private `ltpLadder`, and optional `getLtpClient`.
`LtpReadClient` exposes only `getSymbolInfo` and `getUserFeeRate`; the host may
adapt an existing SDK. No LTP keys or write-capable client are required to use
reference tier pricing.

The page sends these defaults explicitly:

```text
/api/opportunities-ltp?notionalUsd=200000&borosEntry=market&entryMode=maker-hedge&exitMode=close&ltpTier=vip2&perpLeverage=15&borrowLeverage=2&loanRateApr=0.105
```

Raw API calls without parameters retain the original engine defaults: $10k,
5x requested perp leverage, 2x borrowing, 9.5% loan APR, market entry and close
at maturity; an omitted tier uses account rates when an adapter is supplied,
otherwise the VIP1 fallback. APRs on the wire are decimal fractions, amounts
are USD, and `secondsToMaturity`/`asOfSec` are seconds. Groups are already ranked;
null means unavailable, not zero. The page's loan-rate control uses percent
and the query hook converts it to a fraction.

### Private fee configuration is required for the default VIP2 view

Only VIP1 reference rates are committed. Obtain the current approved LTP
schedule separately and either:

- Set `LTP_FEE_TIERS_PATH` to a private JSON file, or
- Pass a parsed `ltpLadder` to the route/`buildApp` dependencies.

The file is a mapping from `vip1`…`vip5` to `{makerRate, takerRate}` in per-fill
decimal fractions. For example, 1 basis point is `0.0001`; negative maker rates
represent rebates. `parseLtpLadder` documents and validates the format. The
fallback file location is `scripts/ltp/fee-tiers.local.json` (gitignored).
The route reads it at startup; restart after a change.

Missing VIP2 fees produce a visible configuration warning and unavailable net
returns. Select VIP1 for an immediate reference-rate smoke check, or supply the
approved VIP2 schedule. Do not silently substitute VIP1 for VIP2. Tier fees are
indicative, DMA fee applicability is unverified, and the page discloses that
DMA account maintenance fees (minimum $2,000/month) are excluded.

## Calculation retained from the published page

For notional `N` per leg, years to maturity `T`, effective per-leg leverages
`Ls`/`Ll`, borrow multiplier `M`, and annual borrowing rate `r`:

```text
required perp collateral = N/Ls + N/Ll
self-funded perp collateral = required / M
borrowed = required - self-funded
loan interest = borrowed * r * T
posted capital = Boros short IM + Boros long IM + self-funded perp collateral
profit = executable fixed spread * N * T - Boros fees - perp fees/slippage - loan interest
APR on posted capital = profit / (posted capital * T)
```

The Boros executable spread already includes book impact; the waterfall starts
at the mid spread and subtracts that impact exactly once. Boros margins, book
walks, and maker/hedge assignment reuse main's pure calculation helpers.
Hyperliquid's public per-asset maximum clamps only the Hyperliquid leg; the
other leg keeps the requested leverage. Missing cap data is explicitly warned.
The liquidation diagram is illustrative, not a live account liquidation feed.

The page retains its original cost assumptions: `maker-hedge` chooses the
cheaper maker/hedge assignment separately for entry and exit. `both-market`
crosses both books. `close` includes exit costs; `roll` sets them to zero. No account-specific Boros rebate
is assumed. This port does not change the economics to the later FalconX
what-if calculations discussed separately.

## Caching and validation

The hook polls every 12 seconds. A matching last scan can seed first paint for
up to 15 minutes and remains a placeholder until refreshed. Market/book/cap
reads opt into stale-while-revalidate; ordinary trading/account cache reads keep
main's blocking behavior and fresh-read generation guards. LTP scan books use a
30-second TTL; static caps/account metadata use 10 minutes. Cache keys can be
shared with other scans. An expired cached quote may be shown during an outage.

The published site's always-on warmer and proxy compression are deployment
infrastructure and are not included. A new process still pays the first cold
fetch; an internal host can warm this authenticated endpoint through its own
scheduler if needed.

```sh
yarn verify
yarn --cwd web build:ltp
```

Coverage includes capital/loan arithmetic, maker rebates, per-leg leverage caps,
thin books, API parameters and degradation, private fee injection, authentication,
SWR behavior, and the page's assumptions/expand-collapse interactions.
