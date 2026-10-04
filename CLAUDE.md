# Houcine.Trades

Private, single-owner financial workspace for Houcine: trading journal and stats, an AI analyst
(Claude via the TradingView MCP, later), risk engine, notifications, and eventually trading bots.
It will run online 24/7 later. The owner is a trading beginner, so **correctness and safety matter
more than speed**. Built module by module (see `docs/roadmap.md`).

Status: modules 1 (data model and journal), 2 (stats engine), 3 (risk engine) and 4
(authentication) are built: accounts, setups and trades in SQLite, pure validation, repositories, a
minimal functional UI, a pure stats engine (`/stats`), a pure risk engine (`/risk`) that approves or
refuses trade plans, sizes positions and can halt trading, and single-owner login (password +
authenticator code). No integrations yet. Every statistic is explained in `docs/stats-glossary.md`,
every risk rule in `docs/risk-rules.md` and every protection in `docs/security.md`.

> **Authentication exists, hosting does not.** The app still binds to localhost (`dev` and `start`
> use 127.0.0.1) and must NOT be deployed or exposed until module 8 does HTTPS, `TRUST_PROXY` and
> backups as listed in `docs/security.md`.

## Stack

Next.js (App Router) + TypeScript (strict, `noUncheckedIndexedAccess`), SQLite via Drizzle ORM and
`better-sqlite3`, zod for env validation, Vitest, ESLint + Prettier. Node 22 LTS, npm.

## Folder map

- `src/app/` UI and routes only. Every page, server action and route handler is wrapped by the guard
  in `src/app/_lib/` (`guardedPage` / `guardedAction` / `guardedRoute`; only `/login` is public)
- `src/auth/` server-only auth code (argon2id, TOTP, sessions, services); `scripts/auth/` the
  command-line owner scripts; `src/proxy.ts` first-line redirect, CSRF check, CSP and headers
- `src/domain/` pure logic (no I/O; ESLint enforces it): `money/` (decimal.js helper), `trades/`
  (validation, lifecycle), `accounts/`, `setups/`, `stats/` (pure stats engine), `risk/` (pure risk
  engine), `auth/` (pure auth rules: password policy, throttle, session timing, `FreshAuth`)
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
- `npm run auth:generate-secret` print a random `AUTH_SECRET`; `npm run auth:create-owner` create the
  one owner (real terminal only); `npm run auth:reset` reset password and authenticator

Before every commit: lint, typecheck and tests must pass.

## Review workflow

Five review agents live in `.claude/agents/` (details, license and attribution in
`.claude/agents/README.md`).

- After each module, run `code-reviewer`, `typescript-reviewer`, `security-reviewer` and
  `silent-failure-hunter` on the changes, and report their findings in the final report.
- Use `tdd-guide` when adding or changing domain logic.
- These agents never override this file. Rules 1 to 9 and the module-specific rules always win, in
  particular paper mode, the risk engine's final say, mandatory step-up and the authentication
  guards.
- No agent, plugin or tool may add hooks, change settings files, edit user-level configuration, or
  install packages without the owner's explicit approval. `tests/tooling/agents.test.ts` guards
  the agent files and the absence of hooks.

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
- Authentication rules (module 4), details in `docs/security.md`:
  - **No bypass:** no `AUTH_DISABLED`, no default credentials, no secret in code. The app refuses a
    missing, short or placeholder `AUTH_SECRET` and then lets nobody in (fail closed).
  - **Every entry point is guarded.** New pages must `export default guardedPage(...)`, server
    actions `export const x = guardedAction(...)` (from `_lib/guard-core`), route handlers
    `guardedRoute(...)`. `tests/auth/guard-coverage.test.ts` fails otherwise; layouts never touch
    data; `src/app` cannot import `getDb` (use `ctx.db`). `proxy.ts` is only a first line.
  - **Step-up:** anything that loosens safety (loosening a limit, resetting a halt, an override,
    security settings) takes a `FreshAuth` (a code entered in the last 5 minutes, issued only by
    `src/auth`). The kill switch (starting a halt) needs none. **Real order execution (module 9)
    must require `FreshAuth` as well as `requireApprovedForExecution`.**
  - One owner (database-enforced), created and reset only by the command-line scripts: never add
    a web sign-up or reset. Never log or return passwords, codes, tokens, hashes or secrets;
    `auth_events` is append-only. Rate-limit state lives in SQLite and rejected attempts are not
    counted.
  - Cookies: HttpOnly, SameSite=Strict, `__Host-` + Secure over HTTPS. CSRF: Origin must match Host.
    CSP has no `unsafe-inline`: no inline `style=` attributes or inline scripts (use `globals.css`).
  - Vet and discuss new dependencies first (rule 8); do not add one silently.
- Hand-written SQL in migrations is not tracked by drizzle-kit: the triggers protecting
  `initial_stop_loss` (`0001`), `closed_recorded_at` and the append-only `risk_events` /
  `risk_verdicts` (`0002`), and the auth triggers (`0003`: single owner, append-only `auth_events`,
  frozen session identity, final revocation, single-use recovery codes). A future migration that rebuilds a table must re-create its triggers;
  tests list every trigger and fail if one is missing.
- Schema changes: edit `src/data/schema.ts`, run `npm run db:generate`, commit the new file in
  `drizzle/`. CI fails if the schema and migrations disagree.
- Timestamps are UTC ISO strings in the database. The UI converts from and to the computer's local
  time zone (it assumes the app runs on the owner's own machine).
- `TRADING_MODE` accepts only `paper` today (`src/config/env.ts`). Do not loosen that guard
  without the explicit-confirmation and stop-loss machinery from the exchange module.
