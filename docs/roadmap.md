# Roadmap

Modules are built in this order, each on its own branch with tests and small commits.

1. **Data model and journal** - **DONE**: tables (Drizzle), committed migrations, trade journal
   with a minimal UI. Money rule decided: decimal strings in TEXT columns plus decimal.js. _Done
   when_: trades can be logged, listed and closed, with tests. Carried forward: trades in
   different quote currencies cannot be added together without conversion, so the stats engine
   must group by currency; the UI has no login (module 4) and must stay on localhost.
2. **Stats engine** - **DONE**: pure, tested statistics per account and per quote currency (win
   rate, R-multiples, expectancy, profit factor, payoff ratio, streaks, max drawdown, equity curve,
   breakdowns by setup, symbol, direction and asset class) and a plain `/stats` page. Added a
   frozen `initial_stop_loss` so R stays honest. _Done when_: stats match hand-computed fixtures
   (they do; see `src/domain/stats/golden.test.ts`). Plain-language definitions are in
   `docs/stats-glossary.md`. Carried forward: spot-style P&L only (no leverage, multipliers or
   funding); fees in another currency are flagged, not converted; drawdown percentage only exists
   for trades quoted in the account's base currency (set the base currency to the currency you
   trade in); R for trades that existed before the migration depends on a backfilled stop.
3. **Risk engine** - **DONE**: pure, tested rule engine that approves or refuses trade plans
   (mandatory stop on the correct side, 1 % per trade, 3 % open risk, 3 open trades, reward-to-risk
   warning, currency check, fail-closed), an exact position-size calculator (always rounded down),
   a daily-loss halt, a drawdown halt (reset only after 24 h, typed confirmation and reason), a
   manual kill switch, hard ceilings, settings that tighten at once and loosen after 24 h, an
   append-only event log, a verdict snapshot on every trade, a typed-override journal gate, and a
   `/risk` page plus a live verdict in the new-trade form. Plain-language rules in
   `docs/risk-rules.md`. _Done when_: a plan that breaks a limit is refused with reasons, sizing is
   exact, the kill switch works, tests pass (they do). Carried forward: unrealised P&L is not
   counted (needs live prices); no currency conversion; override trades are flagged but not yet
   separated in the stats (proposal in `docs/risk-rules.md`: a `ruleOverride` field and a "By rule
   compliance" breakdown); repeated drawdown resets are possible by design (each is logged);
   closed times are typed by you (the recorded time covers backdating).
4. **Authentication** - **DONE**: single-owner login with password (argon2id) plus authenticator
   code (TOTP) and 10 single-use recovery codes; the owner is created and reset only by command
   line (`npm run auth:create-owner`, `auth:reset`); server-side sessions (hashed token, idle
   and absolute timeouts, rotation, revocation); `/login`, `/security`, `/step-up`; a fresh
   authenticator code (step-up, 5 minutes, type-enforced `FreshAuth`) for loosening limits,
   resetting halts, overrides and security settings, while the kill switch stays one click; a guard
   on every page, action and route handler enforced by tests; Origin/Host CSRF check, nonce-based CSP
   and security headers; progressive rate limiting kept in SQLite; append-only `auth_events`. Plain
   language in `docs/security.md`. _Done when_: every route and API is protected (it is, and a test
   proves it). Carried forward: the app still binds to 127.0.0.1 and hosting needs module 8
   (HTTPS, `TRUST_PROXY`, backups of the database and of `AUTH_SECRET`).
5. **Dashboard UI** - **DONE**: the "Ledger" design (calm, editorial, warm paper and ink; light and
   dark themes from CSS variables in one tokens file, system fonts only), an app shell that shows
   PAPER and any halt on every page, a dashboard (equity, today, open trades with their risk, risk
   limits in use, results per currency with a small equity curve, last closed trades, a guided empty
   state), a journal with filters, sorting and pagination, a trade detail page (timeline, planned
   versus actual, result, risk verdict snapshots, override flag, notes), polished create, open,
   close, cancel and edit flows with the live verdict and a position-size helper, the stats page
   with an equity-and-drawdown chart and an R distribution, the risk page with usage bars and the
   24-hour countdown, "What does this mean?" help read from the docs (single source), and
   `npm run dev:seed` for a separate DEMO database. New engine outputs, with tests: risk usage figures
   and the R distribution. _Done when_: the owner can use the journal, stats and risk pages daily
   without reading code (it can; see the browser checks in the module report). Carried forward: no
   live prices, so open trades show their risk at the stop but no unrealised result; the size helper
   uses the per-trade limit only (the Risk page calculator takes any risk %); no favicon or logo
   (text wordmark only, and the proxy must not serve public files); the demo override example is a
   directly inserted demo record (the real override path needs a fresh code). Known and accepted:
   the `?ok=` / `?error=` notices come from the address and only look like confirmations (a
   crafted link could show a false "saved" text; nothing is changed by it); an error or "not found"
   page renders without the header; if the remembered account was deleted the first account is
   shown without a notice.
6. **Claude analyst v1 (journal coach)** - **DONE**: an AI that reviews and explains and never
   decides: plan review after the risk verdict, a weekly review per currency, a tutor, all with
   structured output checked by zod, every cited figure matched against the input, a trade-instruction
   wording check, escaped plain-text rendering, no tools (text in, text out), a privacy switch (OFF by
   default, turning it ON needs a fresh code), spend caps with ceilings in code (tighten now, loosen
   after 24 h with a code), an append-only usage log and stored reviews, a price table with a
   last-verified date, `npm run ai:set-key` (hidden input) and `docs/analyst.md`. The API client is
   plain `fetch` (no new dependency). _Done when_: the three features work against a fake client, the
   app works unchanged without a key, caps and fail-closed behaviour are tested (they are).
   Carried forward: **the first real call has not been made** (no key or network in the build
   session): the request follows the current official docs and failures show a plain message with the
   provider's request id; the TradingView MCP half of this item is NOT built (it stays here until it
   is vetted, rule 8); figures quoted in running prose (not in the cited list) are not checked; the
   instruction-wording check is a rough word list; the estimated cost is an estimate (the Console
   limit is the real stop); `src/analyst/` is a new layer between `app` and `integrations`.
   TradingView MCP: still to do.
7. **Notifications** - **DONE**: one-way Telegram alerts for events INSIDE the app. Events are derived
   (pure, tested) from existing records and from the limits' usage: limits at 50/80/100 %, halts started and
   cleared, a refused drawdown reset, overrides, sign-in failures (summarized), sign-ins, recovery codes,
   password and security changes, analyst caps and failed calls; reserved types for backups and market data.
   Recorded first (append-only outbox), delivered later with capped backoff, a 24 h maximum age, an hourly
   ceiling (20 plus 10 critical) and one summary; fixed message templates with no free text; a channel
   interface (Telegram adapter on `fetch`, fake adapter for tests); `npm run notify:worker`,
   `npm run notify:set-telegram` (hidden token, one-time-code pairing, private chat only); a master switch
   (OFF by default; ON and OFF need a fresh code; OFF sends one final notice); category switches and minimum
   severity (quieter changes wait 24 h; critical never off); the `/notifications` page and a header indicator;
   `docs/notifications.md`. _Done when_: events are recorded reliably, delivered through the interface, nothing
   is sent until switched on with consent, failures never block the app (they do not: proven by tests).
   Carried forward: **the first real Telegram call has not been made** and several Telegram facts are
   unconfirmed (listed in `docs/notifications.md`, "to confirm on first live test"); delivery is
   at-least-once (one message may repeat after a crash); no price or market alerts (no market data); other
   channels are only the interface; the worker is a script until module 8 runs it as a service; a held-back
   event older than 24 h expires and is never sent.
8. **24/7 deployment and backups**: hosting (persistent disk for SQLite), HTTPS, automated
   encrypted backups, restore test.
9. **Exchange adapter (testnet)** with confirm button and kill switch (**no override: orders must pass
   `requireApprovedForExecution`**): every order needs explicit
   confirmation and a stop-loss. Keys are trade-only with withdrawals disabled.
10. **Bots framework**: paper mode by default, same risk and confirmation gates.
11. **Knowledge base and connector registry**.

## Required before the relevant step

- **Authentication (module 4) before any hosting or network exposure** - built. The app still binds
  to 127.0.0.1 only; `docs/security.md` lists what module 8 must do (HTTPS, proxy and
  `TRUST_PROXY`, backups, `AUTH_SECRET`).
- **Backups (module 8):** until then the SQLite file in `data/` is the only copy of the journal.
  Copy `data/houcine-trades.db` (with the app stopped) if the data matters.
- **Secret scanning:** gitleaks runs in CI (`secret-scan` job), next to a built-in test
  (`tests/security/secret-scan.test.ts`) and an optional pre-commit hook. **It must be green before
  any real API key is used**, at the latest before module 6 (Claude/TradingView keys) and
  certainly before module 9.
- **Module 9 must require `FreshAuth`** (and `requireApprovedForExecution`) for anything that can
  place an order.
- Turn on GitHub branch protection for the default branch (PRs required, CI required) to enforce
  rule 7.
- Known: `npm audit` reports dev-only advisories (`braces` via `eslint-config-next`, and an old
  `esbuild` inside `drizzle-kit`'s legacy loader). They affect lint and migration tooling on the
  developer's machine only; `npm audit --omit=dev` (what the running app uses) reports 0. Re-check
  when dependencies are updated.
