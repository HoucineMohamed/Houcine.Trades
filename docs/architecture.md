# Architecture

Houcine.Trades is a single Next.js app with strict internal layering. The layers exist so that
**math is isolated and testable (rule 3)** and **nothing can reach an exchange by accident
(rule 4)**.

```
src/
  app/            UI and routes
  domain/         pure logic: risk/, stats/
  data/           SQLite + Drizzle
  integrations/   tradingview-mcp/, exchanges/
  bots/           future bots framework
  config/         env validation, paper-mode guard
```

## Layers

- **app**: pages and API routes. Calls `domain` and `data`. May not import `integrations` or
  `bots` directly (ESLint rule); anything external goes through a service that applies risk checks.
- **domain**: pure, deterministic functions (position size, risk, stats). No database, network,
  filesystem, clock or randomness unless passed in. ESLint blocks imports of `data`,
  `integrations`, `bots`, `app`, Node I/O and the ORM.
- **data**: the only place that talks to SQLite. `client.ts` opens the database lazily (never at
  import time), `schema.ts` defines the tables, and the repositories (`accounts`, `setups`,
  `trades`) take the database as a parameter so tests can use in-memory SQLite. Repositories call
  the domain rules before every write and run writes in a transaction. The DB file lives in
  `data/` and is gitignored; migrations are committed in `drizzle/`.
- **integrations**: adapters for TradingView MCP and exchanges. Exchange adapters start on
  testnet, use trade-only keys with withdrawals disabled, and can only place an order after
  explicit user confirmation and with a stop-loss.
- **bots**: future automation; same risk engine and confirmation rules as manual trading.
- **config**: validates `.env` with zod. `TRADING_MODE` only accepts `paper`.

## Data model (module 1)

Tables: `accounts` (paper or live mode, base currency, starting balance), `setups` (strategy
tags, unique name) and `trades` (one row per trade, with a mandatory stop-loss). Accounts and
setups cannot be deleted while trades refer to them (`ON DELETE RESTRICT`), so the journal stays
intact. CHECK constraints in SQLite repeat the key rules (valid enums, non-empty stop-loss,
open/closed trades have their entry/exit data) as a last line of defence behind the domain code.

**Money rule:** amounts, prices, sizes and fees are decimal strings in TEXT columns, processed
only by `src/domain/money/decimal.ts` (decimal.js). Plain unsigned decimal text only, up to 30
digits before and 18 after the point. No floats, no SQL arithmetic on money.

**Trade lifecycle:** `planned -> open -> closed` and `planned -> cancelled`. Closing needs an exit
price and a closed time not earlier than the opened time. After closing, prices and size are
locked; only review notes, emotion and screenshot can change. Cancelled trades are fully locked.
Open trades can change stop-loss, take-profit, fees, setup and notes. Stop-loss must be below the
entry for a long and above it for a short; take-profit is on the opposite side. Every edit
re-checks all rules.

**Paper-mode guard:** accounts are created in `paper` mode only. A `live` account is refused
while `TRADING_MODE` is `paper` (the only value the config accepts today).

**Not here yet:** profit/loss, R-multiple and any statistics (module 2), risk limits (module 3).

## UI and server actions

`src/app` has plain HTML pages (accounts, setups, trade list, new trade, edit trade) that call the
repositories through Next.js server actions. `src/app/_lib/form.ts` and `trades/mapping.ts` only
translate HTML form text (blank values, local time to UTC); all validation happens in the domain.
Pages call `requireDb()`, which waits for a real request so `next build` never opens a database.

> **WARNING: no authentication exists yet (module 4).** Server actions can be called by anyone who
> can reach the server. The app must run on localhost only (`dev` and `start` bind to 127.0.0.1)
> and must not be deployed until authentication is built.

## Data and hosting

SQLite needs a persistent disk, so 24/7 hosting later means a small VPS or similar, not
serverless. `better-sqlite3` is a native module (`serverExternalPackages` in `next.config.ts`).

## Testing

Vitest. Domain code gets exhaustive unit tests (beside the code). Repositories are tested against
in-memory SQLite with the real migrations applied (`tests/data`, helper in `tests/helpers`), which
also tests the migrations. `tests/app` covers the form-to-domain mapping. The smoke test checks
the paper-mode guard.
