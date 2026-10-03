# Houcine.Trades

Private, single-owner financial workspace for Houcine: trading journal and stats, an AI analyst
(Claude via the TradingView MCP, later), risk engine, notifications, and eventually trading bots.
It will run online 24/7 later. The owner is a trading beginner, so **correctness and safety matter
more than speed**. Built module by module (see `docs/roadmap.md`).

Status: modules 1 (data model and journal), 2 (stats engine) and 3 (risk engine) are built:
accounts, setups and trades in SQLite, pure validation, repositories, a minimal functional UI, a
pure stats engine (`/stats`) and a pure risk engine (`/risk`) that approves or refuses trade
plans, sizes positions and can halt trading. No auth or integrations yet. Every statistic is
explained in `docs/stats-glossary.md` and every risk rule in `docs/risk-rules.md`.

> **WARNING: there is no authentication yet (module 4).** The app must only run on localhost
> (`dev` and `start` bind to 127.0.0.1) and must NOT be deployed or exposed to a network until
> authentication exists.

## Stack

Next.js (App Router) + TypeScript (strict, `noUncheckedIndexedAccess`), SQLite via Drizzle ORM and
`better-sqlite3`, zod for env validation, Vitest, ESLint + Prettier. Node 22 LTS, npm.

## Folder map

- `src/app/` UI and routes only
- `src/domain/` pure logic (no I/O; ESLint enforces it): `money/` (decimal.js helper), `trades/`
  (validation, lifecycle), `accounts/`, `setups/`, `stats/` (pure stats engine), `risk/` (pure risk engine)
- `src/data/` database access: `schema.ts`, `client.ts`, repositories (`accounts`, `setups`, `trades`,
  `risk`, `risk-events`) and the `journal.ts` gate (every trade enters through the risk engine)
- `drizzle/` committed SQL migrations (generated, do not edit by hand)
- `src/integrations/` `tradingview-mcp/`, `exchanges/` (future adapters)
- `src/bots/` future bots framework
- `src/config/` env loading and the paper-mode guard
- `tests/` cross-cutting tests; module tests may sit beside their code as `*.test.ts`
- `docs/` `architecture.md`, `roadmap.md`

Dependency direction: `app -> domain, data`; `data -> domain, config`; `integrations -> domain`;
`bots -> domain, integrations`. `domain` imports from none of them.

## Commands

- `npm run dev` start dev server (http://127.0.0.1:3000, localhost only)
- `npm test` run tests once (`npm run test:watch` to watch)
- `npm run lint` ESLint; `npm run typecheck` tsc; `npm run format` Prettier
- `npm run build` production build
- `npm run db:migrate` apply migrations to the database in `DATABASE_URL` (run once after cloning
  and after pulling new migrations)
- `npm run db:generate` create a new migration after changing `src/data/schema.ts` (commit it)

Before every commit: lint, typecheck and tests must pass.

## Non-negotiable rules

1. Never commit secrets. All keys live in `.env` (gitignored); keep `.env.example` up to date with
   placeholder values only.
2. The database file and any trade data are gitignored.
3. All calculations (risk, position size, stats) are done in deterministic, tested code. The AI
   never does the math.
4. No code path may place a real order unless the user explicitly confirms it, and every order
   must carry a stop-loss. Real execution does not exist yet; it is built in a later prompt.
5. Everything runs in paper mode by default.
6. Exchange API keys are trade-only, withdrawals disabled (documented rule).
7. Every module is built on its own branch, with tests, and small commits. Never push to main
   directly.
8. Third-party MCP servers, repos, and packages are vetted before use.
9. Authentication will be single-owner and is built before any hosting.

## Working conventions

- New module checklist: own branch, tests first for any math, small commits, update
  `docs/roadmap.md`, `.env.example` and this file if commands or rules change.
- Money rule (decided in module 1): amounts, prices, sizes and fees are decimal STRINGS stored in
  TEXT columns and handled only with `src/domain/money/decimal.ts` (decimal.js). Never use JS
  floats for money and never do SQL arithmetic or numeric comparison on money columns. Every
  amount carries its currency/asset code.
- Trade rules live in one place, `src/domain/trades/` (stop-loss mandatory and on the correct
  side, size and prices > 0, allowed status moves, locks after close). Repositories always call
  them before writing; do not bypass them. Tests for repositories use in-memory SQLite and must
  never create a database file.
- Stats rules (module 2): all statistics are computed only in `src/domain/stats/`; the data layer
  (`src/data/stats.ts`) only loads plain objects and the UI only displays results. Currencies are
  never added together or converted: everything is computed per quote currency. R-multiples use
  `initialStopLoss` (frozen when the trade opens), NEVER the editable `stopLoss`. The word "gross"
  always means "before fees"; the sums of winning and losing trades are called "total winners" and
  "total losers" (measured after fees). Numbers that cannot be computed are `null` with a reason,
  never zero and never a crash. Assumption: spot-style P&L (no leverage, multipliers or funding).
- Risk rules (module 3): the risk engine in `src/domain/risk/` has the final say; it FAILS CLOSED
  (missing, invalid or ambiguous data is a refusal), compares limits with exact decimals, rounds
  size DOWN, and allows exactly-at-limit (but a halt triggers when its limit is reached). Hard
  ceilings (2 % per trade, 5 % per day, 6 % open risk, 6 trades, 20 % drawdown) live in code. All
  halts are DERIVED from the trades and the append-only `risk_events` log, so a restart can never
  lose one. Equity = starting balance + net realised P&L from the stats engine, in the account
  base currency only (no unrealised P&L, no currency conversion). The UTC day decides "today".
- Every trade enters the journal through `logTrade` / `openTradeChecked` in `src/data/journal.ts`
  (an ESLint rule stops `src/app` from importing the unchecked `createTrade` / `openTrade`). A
  refused plan may be LOGGED only with a typed `OVERRIDE` and a reason, and is flagged forever.
  **REAL ORDER EXECUTION (module 9) HAS NO OVERRIDE:** it must call
  `requireApprovedForExecution(verdict)`; a refused plan can never become an order.
- Hand-written SQL in migrations is not tracked by drizzle-kit: the triggers protecting
  `initial_stop_loss` (`0001`), `closed_recorded_at` and the append-only `risk_events` /
  `risk_verdicts` (`0002`). A future migration that rebuilds a table must re-create its triggers;
  tests list every trigger and fail if one is missing.
- Schema changes: edit `src/data/schema.ts`, run `npm run db:generate`, commit the new file in
  `drizzle/`. CI fails if the schema and migrations disagree.
- Timestamps are UTC ISO strings in the database. The UI converts from and to the computer's local
  time zone (it assumes the app runs on the owner's own machine).
- `TRADING_MODE` accepts only `paper` today (`src/config/env.ts`). Do not loosen that guard
  without the explicit-confirmation and stop-loss machinery from the exchange module.
