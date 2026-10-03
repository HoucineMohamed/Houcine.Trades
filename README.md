# Houcine.Trades

Private trading workspace for one user: journal, stats, risk engine, AI analyst, and later
bots. **Module 1 (journal) is built**: you can log paper trades, list them, edit them and close
them. Everything runs in **paper mode**.

> ## ⚠️ LOCALHOST ONLY - NO LOGIN YET
>
> The app has **no authentication** until module 4. Run it only on your own computer
> (`npm run dev` and `npm start` listen on 127.0.0.1 only). **Do not deploy it, do not expose it
> to a network, and do not change the host setting** until authentication exists. Read `CLAUDE.md` for the rules and `docs/` for architecture and roadmap.

## Requirements

- Node.js 22 LTS and npm
- Git

### Windows (PowerShell)

1. Install Node 22 with [nvm-windows](https://github.com/coreybutler/nvm-windows) (`nvm install 22`,
   `nvm use 22`) or the installer from nodejs.org.
2. `better-sqlite3` is a native module and normally installs from a prebuilt binary. If
   `npm install` fails on it, install "Desktop development with C++" from Visual Studio Build
   Tools and retry.

### macOS

1. `brew install nvm` (or the installer from nodejs.org), then `nvm install 22 && nvm use 22`.
2. If the native build fails: `xcode-select --install`.

## Setup

```
git clone <repo-url>
cd Houcine.Trades
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
npm run db:migrate          # creates the database file in data/ (once, and after new migrations)
npm run dev
```

Open http://127.0.0.1:3000. If you forget `db:migrate`, the app tells you to run it.

## Using the journal

1. **Accounts**: create a paper account (name, base currency, starting balance).
2. **Setups** (optional): strategy tags such as "Breakout".
3. **New trade**: log a trade as `planned` (not taken yet) or `open` (already taken). A stop-loss
   is required; for a long it must be below the entry, for a short above it.
4. **Trades**: open a planned trade, close an open trade with an exit price, cancel a planned
   trade, or edit notes. Closed trades keep their prices locked; you can still add review notes.

5. **Stats**: pick an account to see statistics for its closed trades, one section per currency
   (win rate, net P&L, R-multiples, expectancy, profit factor, drawdown, breakdowns and an equity
   curve table). Every number is explained in plain language in
   [docs/stats-glossary.md](docs/stats-glossary.md). Set the account base currency to the currency
   you actually trade in (USDT for `BTCUSDT`), otherwise you get no drawdown percentage. With fewer
   than 30 closed trades the page warns you that the numbers are not reliable.

6. **Risk**: your safety rules, enforced by tested code. Set your limits, use the kill switch
   ("Halt trading now"), see equity and today's figures, and use the position-size calculator.
   Creating or opening a trade now shows a live risk verdict; a plan that breaks a rule is refused
   with reasons. You can still log it with an **override** (type `OVERRIDE` and a reason), and it is
   flagged forever. Closing a trade is never blocked. Every rule is explained in
   [docs/risk-rules.md](docs/risk-rules.md). **Real orders will never have an override.**

Prices and amounts are stored as exact decimal text (no rounding errors). Times you type are
your computer's local time and are stored as UTC.

## Database and migrations

After pulling module 3, run `npm run db:migrate` again: it adds the risk tables, gives every
existing account the default risk settings and records a "recorded as closed" time for trades that
are already closed.

After pulling module 2, run `npm run db:migrate` once: it adds the frozen `initial_stop_loss` to your
existing database and fills it for trades that are already open or closed.

The database is a single file (`data/houcine-trades.db` by default, set by `DATABASE_URL`). It is
gitignored and contains your trade data: never commit it. Until backups exist (module 8), copy
that file (with the app stopped) if the data matters.

| Command               | When                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run db:migrate`  | after cloning, and after pulling a new migration: applies it to your database                     |
| `npm run db:generate` | only when a developer changed `src/data/schema.ts`: creates a migration in `drizzle/` (commit it) |

CI fails if the schema changed without a committed migration.

## Commands

| Command               | What it does                             |
| --------------------- | ---------------------------------------- |
| `npm run dev`         | dev server                               |
| `npm test`            | run tests once                           |
| `npm run lint`        | ESLint                                   |
| `npm run typecheck`   | TypeScript check                         |
| `npm run format`      | Prettier                                 |
| `npm run build`       | production build                         |
| `npm run db:migrate`  | apply database migrations                |
| `npm run db:generate` | create a migration after a schema change |

## Safety notes

- Never commit `.env`; only `.env.example` (placeholders) is tracked. The database (`data/`) is gitignored.
- Exchange API keys, when added, must be **trade-only with withdrawals disabled**.
- There is no real order execution. `TRADING_MODE` must be `paper`.
- Work on a branch and merge by pull request. On GitHub: Settings -> Branches -> add a rule for
  the default branch requiring a pull request and passing CI.
