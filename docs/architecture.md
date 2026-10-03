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
- **data**: the only place that talks to SQLite. Currently just a lazily-opened client; schema
  comes with the data-model module. The DB file lives in `data/` and is gitignored.
- **integrations**: adapters for TradingView MCP and exchanges. Exchange adapters start on
  testnet, use trade-only keys with withdrawals disabled, and can only place an order after
  explicit user confirmation and with a stop-loss.
- **bots**: future automation; same risk engine and confirmation rules as manual trading.
- **config**: validates `.env` with zod. `TRADING_MODE` only accepts `paper`.

## Data and hosting

SQLite needs a persistent disk, so 24/7 hosting later means a small VPS or similar, not
serverless. `better-sqlite3` is a native module (`serverExternalPackages` in `next.config.ts`).

## Testing

Vitest. Domain code gets exhaustive unit tests. The smoke test in `tests/` also checks the
paper-mode guard.
