# Houcine.Trades

Private, single-owner financial workspace for Houcine: trading journal and stats, an AI analyst
(Claude via the TradingView MCP, later), risk engine, notifications, and eventually trading bots.
It will run online 24/7 later. The owner is a trading beginner, so **correctness and safety matter
more than speed**. Built module by module (see `docs/roadmap.md`).

Status: foundation only. No features, no database tables, no auth, no integrations yet.

## Stack

Next.js (App Router) + TypeScript (strict, `noUncheckedIndexedAccess`), SQLite via Drizzle ORM and
`better-sqlite3`, zod for env validation, Vitest, ESLint + Prettier. Node 22 LTS, npm.

## Folder map

- `src/app/` UI and routes only
- `src/domain/` pure logic: `risk/`, `stats/` (no I/O; ESLint enforces it)
- `src/data/` database access (Drizzle client, future schema and repositories)
- `src/integrations/` `tradingview-mcp/`, `exchanges/` (future adapters)
- `src/bots/` future bots framework
- `src/config/` env loading and the paper-mode guard
- `tests/` cross-cutting tests; module tests may sit beside their code as `*.test.ts`
- `docs/` `architecture.md`, `roadmap.md`

Dependency direction: `app -> domain, data`; `data -> config`; `integrations -> domain`;
`bots -> domain, integrations`. `domain` imports from none of them.

## Commands

- `npm run dev` start dev server (http://localhost:3000)
- `npm test` run tests once (`npm run test:watch` to watch)
- `npm run lint` ESLint; `npm run typecheck` tsc; `npm run format` Prettier
- `npm run build` production build

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
- Money and quantities: never use floating-point for stored monetary values (decide the
  representation in the data-model module, e.g. integer minor units or decimal strings).
- `TRADING_MODE` accepts only `paper` today (`src/config/env.ts`). Do not loosen that guard
  without the explicit-confirmation and stop-loss machinery from the exchange module.
