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
4. **Authentication**: single-owner login. Must exist before any hosting. _Done when_: every
   route and API is protected.
5. **Dashboard UI**: journal and stats views. _Done when_: owner can use it daily locally.
6. **Claude analyst and TradingView MCP**: AI analysis; the AI never does the math. Vet the MCP
   server first (rule 8).
7. **Notifications**: alerts for risk limits and events.
8. **24/7 deployment and backups**: hosting (persistent disk for SQLite), HTTPS, automated
   encrypted backups, restore test.
9. **Exchange adapter (testnet)** with confirm button and kill switch (**no override: orders must pass
   `requireApprovedForExecution`**): every order needs explicit
   confirmation and a stop-loss. Keys are trade-only with withdrawals disabled.
10. **Bots framework**: paper mode by default, same risk and confirmation gates.
11. **Knowledge base and connector registry**.

## Required before the relevant step

- **Authentication (module 4) before any hosting or network exposure.** Until then the app binds
  to 127.0.0.1 only, and every page shows a warning.
- **Backups (module 8):** until then the SQLite file in `data/` is the only copy of the journal.
  Copy `data/houcine-trades.db` (with the app stopped) if the data matters.
- **Secret scanning (gitleaks)** is deferred but **must be added (pre-commit and CI) before any
  real API key is used**, at the latest before module 6 (Claude/TradingView keys) and certainly
  before module 9.
- Turn on GitHub branch protection for the default branch (PRs required, CI required) to enforce
  rule 7.
- Known: `npm audit` reports dev-only advisories (`braces` via `eslint-config-next`, and an old
  `esbuild` inside `drizzle-kit`'s legacy loader). They affect lint and migration tooling on the
  developer's machine only; `npm audit --omit=dev` (what the running app uses) reports 0. Re-check
  when dependencies are updated.
