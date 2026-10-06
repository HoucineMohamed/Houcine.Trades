# Houcine.Trades

Private trading workspace for one user: journal, stats, risk engine, AI analyst, and later
bots. **Modules 1 to 5 are built**: journal, stats, risk engine, **single-owner login**
(password + authenticator code) and a calm **dashboard**. Everything runs in **paper mode**.

> ## Login exists, but hosting does not
>
> Every page needs your login. The app still listens on 127.0.0.1 only (your own computer).
> **Do not change the host setting or deploy it** until module 8 (HTTPS, backups): read
> [docs/security.md](docs/security.md) first. Read `CLAUDE.md` for the rules and `docs/` for
> architecture and roadmap.

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
npm run auth:generate-secret   # prints a long random text: paste it as AUTH_SECRET in .env
npm run db:migrate          # creates the database file in data/ (once, and after new migrations)
npm run auth:create-owner   # creates YOU as the only user (see below)
npm run dev
```

Open http://127.0.0.1:3000 and sign in. If you forget `db:migrate`, the app tells you to run it.

### Create the owner (once)

You need an authenticator app on your phone (for example Google Authenticator, Microsoft
Authenticator, Aegis or 1Password).

1. Run `npm run auth:generate-secret`. It prints one long line of random characters.
2. Open the file `.env` (created from `.env.example`). Replace the text after `AUTH_SECRET=` with
   that line. Save. **Keep a private copy of it** (a password manager); never share it or commit
   it. `.env` is ignored by git.
3. Run `npm run db:migrate`.
4. Run `npm run auth:create-owner` in a **real terminal window** (not a pipe or an editor
   console). It asks for your new password twice. You will not see it while typing; that is
   normal. Use at least 12 characters, for example four or five unrelated words.
5. The screen then shows a **QR code**, a text secret and **10 recovery codes**. In your
   authenticator app choose "add account", scan the QR code (or type the secret). Write the
   recovery codes down on paper or store them in a password manager. **They are shown only once.**
6. Press Enter when asked: the screen is cleared so the codes do not stay visible.
7. Start the app (`npm run dev`) and sign in with your password and the 6-digit code.

Only one owner can ever exist. If you lose your password or phone: sign in with a recovery
code (each works once), or run `npm run auth:reset` in the terminal on the same computer (it asks
you to type `RESET`, then sets a new password and authenticator and ends every session). The
`/security` page lets you change the password, make new recovery codes, see recent sign-in
activity and sign out everywhere. Sensitive actions ask for a fresh authenticator code. All of this
is explained in [docs/security.md](docs/security.md).

## Using the app

- **Dashboard** (the home page): for the account chosen in the header, your equity, today's result,
  open trades with their risk, how much of each risk limit is in use, results per currency with a
  small equity curve, and the last closed trades. A new user sees three steps: create an account,
  review the risk limits, log a first paper trade.
- **Header on every page:** the PAPER badge, any halt (for example "HALTED: manual halt"), the
  account selector (it remembers your choice), and a theme toggle (System, Light, Dark). Under the
  header: the LOCALHOST ONLY reminder.
- **"What does this mean?"** next to a number opens a short explanation taken from
  `docs/stats-glossary.md` and `docs/risk-rules.md`.
- Profit and loss are shown in two neutral colours together with a sign (+ or −) and a word
  (profit, loss, break-even). The app never tells you whether a result is good or bad.

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

## Demo data (optional, a separate database)

To look at a dashboard with data in it, without touching your real journal, fill a **separate demo
database**. The command refuses to run unless `DATABASE_URL` is set to a file with `demo` in its name
(for example `data/demo.db`), it refuses your real journal file, and it prints which file it uses.
Everything it creates is marked DEMO ("DEMO Paper Account"). The demo file is ignored by git.

macOS or Linux:

```
export DATABASE_URL=file:./data/demo.db
npm run dev:seed            # creates the DEMO account and made-up trades (it prints the file it uses)
npm run auth:create-owner   # the demo file needs its own owner (same AUTH_SECRET from .env)
npm run dev                 # open http://127.0.0.1:3000 and sign in
```

Windows PowerShell:

```
$env:DATABASE_URL = "file:./data/demo.db"
npm run dev:seed
npm run auth:create-owner
npm run dev
```

The setting only lasts for that terminal window. When you are done, close the window (or run
`unset DATABASE_URL`, PowerShell: `Remove-Item Env:DATABASE_URL`) and start the app again in a normal
window to use your real journal. To start the demo again, delete `data/demo.db` and repeat. A demo
file that already has accounts is never seeded twice.

## Database and migrations

After pulling module 3, run `npm run db:migrate` again: it adds the risk tables, gives every
existing account the default risk settings and records a "recorded as closed" time for trades that
are already closed.

After pulling module 4, run `npm run db:migrate` again (it adds the login tables), set `AUTH_SECRET`
in `.env` and create the owner (see "Create the owner" above). Until you do, the login page tells
you sign-in is not set up and nobody can use the app.

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

| Command                        | What it does                                                   |
| ------------------------------ | -------------------------------------------------------------- |
| `npm run dev`                  | dev server                                                     |
| `npm test`                     | run tests once                                                 |
| `npm run lint`                 | ESLint                                                         |
| `npm run typecheck`            | TypeScript check                                               |
| `npm run format`               | Prettier                                                       |
| `npm run build`                | production build                                               |
| `npm run db:migrate`           | apply database migrations                                      |
| `npm run db:generate`          | create a migration after a schema change                       |
| `npm run auth:generate-secret` | print a random `AUTH_SECRET`                                   |
| `npm run auth:create-owner`    | create the one owner (password, authenticator, recovery codes) |
| `npm run auth:reset`           | reset the owner's password and authenticator                   |

## Safety notes

- Never commit `.env`; only `.env.example` (placeholders) is tracked. The database (`data/`) is gitignored. A test scans for secrets on every `npm test`; an optional gitleaks pre-commit hook is described in [docs/security.md](docs/security.md).
- Exchange API keys, when added, must be **trade-only with withdrawals disabled**.
- There is no real order execution. `TRADING_MODE` must be `paper`.
- Work on a branch and merge by pull request. On GitHub: Settings -> Branches -> add a rule for
  the default branch requiring a pull request and passing CI.
