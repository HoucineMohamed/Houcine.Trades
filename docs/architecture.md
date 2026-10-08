# Architecture

Houcine.Trades is a single Next.js app with strict internal layering. The layers exist so that
**math is isolated and testable (rule 3)** and **nothing can reach an exchange by accident
(rule 4)**.

```
src/
  app/            UI and routes (every entry point behind the guard)
  auth/           server-only auth code: crypto, TOTP, sessions, services (impure)
  domain/         pure logic: risk/, stats/, auth/ (rules only)
  data/           SQLite + Drizzle
  analyst/        server-only analyst service: gates, one request at a time, input loaders
  notifications/  server-only alerts: collector (derives events), delivery, worker cycle
  integrations/   anthropic/ (the AI client), telegram/ (alert channel), tradingview-mcp/, exchanges/
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

**Initial stop-loss (module 2):** `stop_loss` is the live stop and may be moved while a trade is
open. `initial_stop_loss` is the stop the trade started with: empty while planned or cancelled,
copied from `stop_loss` the moment the trade opens (or is created open), and never changed again.
The domain keeps it out of every edit, and SQLite triggers (hand-written in migration
`0001_initial_stop_loss.sql`, because SQLite cannot add such a constraint to an existing table)
refuse to change or erase it and refuse open or closed rows without it. drizzle-kit does not track
triggers, so a future migration that rebuilds the `trades` table must re-create them (a test checks
they exist). Trades that were already open or closed got it by copying their `stop_loss`.

**Recorded close time (module 3):** `closed_recorded_at` is stamped by the closing write and frozen by a
trigger. The risk engine uses it, together with `closed_at`, to decide which closed trades count as
"today" (a backdated loss still counts). Existing closed trades got their last update time.

## Stats engine (module 2)

`src/domain/stats/` is pure code (decimal.js, no floats, no I/O). The flow:

```
src/data/stats.ts  loadStatsInput(db, accountId)   plain objects: closed trades + starting balance
src/domain/stats   computeAccountStats(input)      all the maths
src/app/stats      /stats page                     displays the result, calculates nothing
```

- **Per trade** (`trade.ts`): gross P&L, fees, net P&L, win/loss/breakeven, initial risk, R before
  and after fees. Spot-style P&L: no leverage, contract multipliers or funding. Fees in a currency
  other than the trade's are left out and flagged, never converted.
- **Per group** (`group.ts`): counts, win rate, totals, averages, expectancy, profit factor, payoff
  ratio, streaks, equity curve and max drawdown, and a sample-size warning (< 30 trades).
- **Grouping** (`account.ts`): trades are split by quote currency first and each currency is
  computed on its own, so amounts of different currencies are never added. Inside each currency
  there are breakdowns by setup, symbol, direction and asset class. Only the account's base
  currency has a starting balance, so only it gets a drawdown percentage.
- **Robustness:** unusable trades are skipped and listed with a reason; every metric that cannot be
  computed is `{ value: null, reason }`. Nothing divides by zero or throws on bad data.
- **Precision:** sums and products are exact; money averages 8 decimals, R and ratios 4 decimals,
  percentages 2 decimals, all rounded half-even once at the end. Details and plain-language
  definitions of every metric: `docs/stats-glossary.md`.
- **Tests:** a golden dataset with hand-worked arithmetic, edge cases, and invariants over 150
  seeded pseudo-random datasets (final equity = start + net P&L, win rate = wins / total, drawdown
  within the peak, breakdowns add up to the whole, input order does not matter).

## Risk engine (module 3)

`src/domain/risk/` is pure code (decimal.js, no floats, no I/O). Plain-language rules:
`docs/risk-rules.md`. The flow:

```
src/data/risk.ts      loadRiskContext(db, accountId, now)    loads facts (stats, open trades, events, settings)
src/domain/risk       buildRiskContext(...)                  equity, day figures, halts (all derived)
src/domain/risk       evaluatePlan(plan, context)            verdict: approved, ALL violations, warnings, numbers
src/data/journal.ts   logTrade / openTradeChecked            the gate: verdict -> save, refuse, or override
src/app/risk          /risk page                             settings, halts, kill switch, size calculator, events
```

- **Fail closed:** missing or invalid equity, stop, settings, account, or an open trade whose risk
  cannot be verified all refuse the plan. Plans in another currency than the account are refused
  ("risk cannot be verified without currency conversion").
- **Reuse, not copy:** equity, peak and drawdown walk come from the stats engine
  (`analyzeEquityFrom`, `peakEquity`, `endingEquity`).
- **Halts are derived** from the trades and the append-only event log: a daily-loss halt clears at
  the next UTC midnight; drawdown (reset only 24 h after it began) and manual halts need your typed
  reset. A reset records a new drawdown baseline. Settings loosening waits 24 h; hard ceilings are
  in `settings.ts`.
- **Tables:** `risk_settings` (JSON, validated on every load), `risk_events` and `risk_verdicts`
  (append-only via triggers). Each trade gets a verdict snapshot when created and when opened.
- **Journal gate:** `logTrade` and `openTradeChecked` evaluate first. Approved: saved with the
  verdict. Refused: not saved, refusal logged. Refused + typed `OVERRIDE` + reason: saved, flagged,
  logged. An ESLint rule keeps the UI from using the unchecked create/open functions.
  Closing is never blocked. **Real order execution has no override**
  (`requireApprovedForExecution`).
- **Tests:** hand-computed golden cases, exact boundaries (at the limit passes, one unit over
  fails), fail-closed cases, halts over time (before, exactly at and after 24 h; next UTC day),
  restart simulation (the database copied into a fresh connection), settings ceilings and delays,
  and invariants over 300 seeded random cases each for the calculator and the evaluation.

## UI and server actions

`src/app` has plain HTML pages (accounts, setups, trade list, new trade, edit trade, stats) that call the
repositories through Next.js server actions. `src/app/_lib/form.ts` and `trades/mapping.ts` only
translate HTML form text (blank values, local time to UTC); all validation happens in the domain.
The `/stats` page only displays what the engine returns (numbers and flags, no advice). Pages and actions get the database from the guard context, which waits for a real request so `next build` never opens a database.

## Dashboard UI (module 5)

The UI displays; it calculates nothing (rule 3). Where a number was missing, the engine got a
tested function instead of the page getting arithmetic:

```
src/domain/risk/usage.ts       computeRiskUsage(context)       how much of each limit is in use
src/domain/stats/distribution  computeRDistribution(results)    counts of trades per 0.5 R bucket
src/domain/trades/table.ts     parse query, sort (exact decimals), paginate
src/domain/trades/timeline.ts  the steps of a trade's life
src/data/dashboard.ts          loadDashboard(db, account, now)  read-only: risk context + usage + stats
src/data/journal-view.ts       listJournal / loadTradeDetail    read-only views for the journal
src/app/_lib/*                 format.ts (sign, separators, words), chart.ts (geometry), ui.tsx, charts.tsx
```

- **Design tokens** live only in `src/app/styles/tokens.css` (colours, fonts, sizes, spacing, light and
  dark). `base.css` styles plain HTML elements; `components.css` the components. A test fails if a raw
  colour appears outside the tokens file. The theme (system, light, dark) and the selected account
  are cookies set by guarded actions in `_lib/preferences.ts`; the layout only reads the theme.
- **Shell** (`_lib/shell.tsx`, rendered by `guardedPage`): LOCALHOST ONLY banner, wordmark, PAPER
  badge, risk status (read-only `loadRiskContext`, mapped by `_lib/status.ts`), account selector,
  theme toggle, navigation, logout. Pages that need the account call `selectedAccount(ctx)`.
- **Charts** are inline SVG (`_lib/charts.tsx`) with classes and presentation attributes only, a text
  title and description, and a table of the same values. Geometry (`chart.ts`) converts engine
  numbers to pixel positions; axis labels are the engines' own exact text.
- **Help texts** (`_lib/help.ts`) are looked up by heading (or table row) in `docs/stats-glossary.md`
  and `docs/risk-rules.md`. If a heading is renamed, `help.test.ts` fails; it also fails on advice
  wording. The docs are the only source.
- **Display rules:** profit and loss use a neutral blue and ochre pair together with a sign and a
  word ("profit", "loss", "break-even"); no advice wording; money shown with two decimals from 1
  upward (exact text is unchanged underneath); a figure that cannot be verified is shown as such,
  never as zero.
- **Tests:** formatting, chart geometry, table helpers, usage and distribution maths; rendered pages
  are checked for inline styles, scripts, external URLs and invalid nesting; the stylesheets for
  `url()`, `@import` and raw colours; the discovery test still covers every new page and action.
- **Demo data:** `scripts/dev/` (`npm run dev:seed`) fills a separate DEMO database; its guard
  refuses any file that is not named like a demo file or is the real journal.

## Authentication (module 4)

Full explanation in `docs/security.md`. The structure:

- `src/domain/auth/` is pure: password policy, throttle maths, session timing, the `FreshAuth`
  step-up proof, recovery-code formats.
- `src/auth/` is server-only (`import 'server-only'`): argon2id, AES-GCM, TOTP (`otpauth`), cookies,
  client address, and `service.ts` (login, sessions, step-up, password and recovery management).
- `src/data/auth.ts` and migration `0003_auth.sql` hold the tables (`owner` with `id = 1` enforced,
  `sessions`, `recovery_codes`, append-only `auth_events`, `auth_attempts`) and their triggers.
- `src/app/_lib/guard-core.ts` / `guard.tsx` are THE guard: `guardedPage`, `guardedAction`,
  `guardedRoute` (and `publicPage` / `publicAction` for `/login` only). The wrappers hand out the
  database (`ctx.db`); ESLint forbids `src/app` from importing the database client, so data is
  unreachable without them. `tests/auth/guard-coverage.test.ts` parses `src/app` and fails if any
  page, route handler or server action is unwrapped; `guard-dynamic.test.ts` calls each without a
  session.
- `src/proxy.ts` (Next 16's replacement for middleware) is the first, cheap line: cookie-presence
  redirect, Origin/Host check, CSP nonce and headers (`src/auth/request-checks.ts`). It is not relied
  on alone.
- Layouts never touch data or the session; the signed-in navigation is rendered by `guardedPage`.
- Sensitive data functions (`resetHalt`, `restoreDefaultRiskSettings`, `updateRiskSettings` when
  loosening, `logTrade` / `openTradeChecked` with an override) take a `FreshAuth` and call
  `assertFreshAuth`. Only `src/auth` may create one (ESLint).
- Command-line scripts in `scripts/auth/` (run with `tsx --conditions=react-server`) create and
  reset the owner; there is no web equivalent.

## Analyst (module 6)

Full plain-language description in `docs/analyst.md`. In short:

- `src/domain/analyst/` is pure: the price table (with a last-verified date), spend caps (defaults,
  ceilings, tighten-now / loosen-after-24-hours), the prompt builder (untrusted text is scrubbed,
  cut, quoted line by line and delimited), the output schema (zod), the cited-figure check and the
  instruction-wording check.
- `src/integrations/anthropic/` holds the one interface (`AnalystClient`, text in and text out, no
  tools), the `fetch` implementation (fixed URL, no retries, the key only in a header) and lazy env
  validation (`ANTHROPIC_API_KEY`, `ANALYST_MODEL`). Tests use a fake client with the same interface.
- `src/analyst/` (new layer: `app -> analyst -> data, domain, integrations`) is the only code that
  calls the client. `runAnalyst` checks every gate BEFORE anything leaves the computer (key, settings,
  privacy switch, stored answer, price, usage log, caps), runs ONE request at a time, decides the final
  status, then writes the usage row and the review in one transaction. The input loaders only copy
  engine results; the plan verdict is always recomputed on the server.
- Tables `ai_settings` (one row: privacy switch, caps, pending caps), `ai_usage` (append-only, never
  prompts or answers) and `ai_reviews` (append-only validated answers). Consent and cap changes are
  logged in `auth_events` (migration 0004 rebuilt that table to allow the new kinds and re-created
  its triggers).
- The analyst can never reach the risk engine, the settings writers or an order: a test checks the
  analyst code does not import them, and the model call has no tools.

## Notifications (module 7)

Full plain-language description in `docs/notifications.md`. In short:

- `src/domain/notifications/` is pure: the event kinds (category, severity), the mapping from existing
  records to events, usage levels (50/80/100 % with hysteresis and a one-hour cooldown), the FIXED message
  templates, the outbox policy (backoff, maximum age, hourly ceiling, critical reserve, summary) and the
  settings rules (louder now, quieter after 24 hours).
- `src/integrations/telegram/` holds the `NotificationChannel` interface (send only), the `fetch` adapter
  (the token is inside the URL, so every failure becomes a short code and nothing is ever logged or thrown
  with a URL) and lazy env validation. The pairing source is used only by the setup script.
- `src/notifications/` is the only code that sends. `collectEvents` reads NEW rows of the risk, verdict, auth
  and analyst logs plus the current usage of the limits (read-only) and records events with a unique dedupe
  key together with its watermarks, in one transaction. `deliverPending` claims what is due in an IMMEDIATE
  transaction (so the worker and the button cannot double-send), sends through the channel, and records every
  attempt. `runCycle` never throws. Nothing in the trade, halt, risk, login or analyst code calls any of it.
- Tables `notification_settings` (one row), `notification_state` (watermarks, last levels), append-only
  `notification_events` and `notification_deliveries` (migration 0005; short codes only). Master-switch and
  settings changes are logged in `auth_events` (rebuilt again, with its triggers re-created).
- Runs from `npm run notify:worker` (hosted: the worker process under the supervisor, see Hosting below) and
  the guarded buttons. No timer in the web server.

## Hosting and backups (module 8)

Beginner guide: `docs/deploy.md`. SQLite needs a persistent disk and a single writer, so the hosted app is
ONE container on ONE instance (managed platform, EU region, persistent disk), not serverless.
`better-sqlite3` is a native module (`serverExternalPackages` in `next.config.ts`).

- **One image, two processes.** `Dockerfile` (digest-pinned Node 22, build on the full image, run on the slim
  one, no dev dependencies, started as root only to fix the disk's ownership then dropped to the `node`
  user by `docker-entrypoint.sh`). `scripts/host/start.ts` (`npm run host:start`) runs `src/hosting/boot.ts`:
  start-up rules, a staged restore if one waits, the RELEASE step, the rules again, then either setup mode or
  the supervisor (`src/hosting/supervisor.ts`) with the web server (`next start -H 0.0.0.0 -p $PORT`) and the
  worker (`scripts/host/worker.ts`). Every step fails closed and spawns nothing on failure. Local `npm start`
  still binds to 127.0.0.1.
- **Pure rules** in `src/domain/hosting/`: start-up rules, retention (7 daily, 4 weekly, 6 monthly, 5
  pre-migration, never the newest), backup health (36 hours), schedule (daily, retry every 30 minutes), mount
  table parsing, crash policy, log redaction.
- **Backups** (`src/hosting/backup.ts`): SQLite's online backup to a private file, integrity check, gzip, then
  AES-256-GCM with a per-backup HKDF key from `BACKUP_KEY` (`crypto.ts`, built-in crypto only), upload to any
  S3-compatible store (`object-store.ts`, `fetch` plus a hand-written SigV4 signer in `sigv4.ts`, tested
  against Amazon's published examples), then a read-back check. Only a checked backup counts. Each attempt
  is an append-only row in `backup_runs` (migration 0006) and, while alerts are on, an event in the existing
  outbox (new system kinds registered in `src/domain/notifications`).
- **Release step** (`release.ts`): the only place migrations run. New disk: migrate. Pending migrations: a
  verified pre-migration backup first, then migrate in one transaction, then check. A database from a NEWER
  app is refused. Failure leaves the old database untouched and the container stops.
- **Restore** (`restore.ts`): stage into a NEW file next to the database (decrypt, integrity, migrations
  check), apply only at the next start before anything opens the database; the old file is kept.
- **Identity.** `HOSTED=true` makes every request count as HTTPS (`src/auth/hosted.ts`), so cookies are
  `Secure` with `__Host-` and HSTS is always sent. The client address is the LAST `X-Forwarded-For` entry
  (the one the platform appends). `/healthz` is the only public route besides `/login`.
- **Status:** `/backups` page, header badges, `GET /healthz` (database readable and the worker's sign of life
  fresh; answers only `ok` or `not ok`).
- Tests use a fake object store (`tests/helpers/object-store.ts`) and fake processes
  (`tests/helpers/fake-child.ts`); the container is proven by `scripts/ci/container-smoke.sh` in CI.

## Testing

Vitest. Domain code gets exhaustive unit tests (beside the code). Repositories are tested against
in-memory SQLite with the real migrations applied (`tests/data`, helper in `tests/helpers`), which
also tests the migrations. `tests/app` covers the form-to-domain mapping. The stats engine tests live beside it in `src/domain/stats/`. The smoke test checks
the paper-mode guard.
