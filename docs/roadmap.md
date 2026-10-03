# Roadmap

Modules are built in this order, each on its own branch with tests and small commits.

1. **Data model and journal**: tables (Drizzle), migrations, trade journal CRUD. Decide money
   representation. _Done when_: trades can be stored and read with tests.
2. **Stats engine**: win rate, expectancy, drawdown, etc. as pure functions. _Done when_: stats
   match hand-computed fixtures.
3. **Risk engine**: position sizing, max risk, stop-loss validation. _Done when_: sizing is tested
   against edge cases and rejects orders without a stop-loss.
4. **Authentication**: single-owner login. Must exist before any hosting. _Done when_: every
   route and API is protected.
5. **Dashboard UI**: journal and stats views. _Done when_: owner can use it daily locally.
6. **Claude analyst and TradingView MCP**: AI analysis; the AI never does the math. Vet the MCP
   server first (rule 8).
7. **Notifications**: alerts for risk limits and events.
8. **24/7 deployment and backups**: hosting (persistent disk for SQLite), HTTPS, automated
   encrypted backups, restore test.
9. **Exchange adapter (testnet)** with confirm button and kill switch: every order needs explicit
   confirmation and a stop-loss. Keys are trade-only with withdrawals disabled.
10. **Bots framework**: paper mode by default, same risk and confirmation gates.
11. **Knowledge base and connector registry**.

## Required before the relevant step

- **Secret scanning (gitleaks)** is deferred but **must be added (pre-commit and CI) before any
  real API key is used**, at the latest before module 6 (Claude/TradingView keys) and certainly
  before module 9.
- Turn on GitHub branch protection for the default branch (PRs required, CI required) to enforce
  rule 7.
- Known: `npm audit` reports a dev-only advisory (`braces`, via `eslint-config-next`). It affects
  lint tooling only, not runtime. Re-check when dependencies are updated.
