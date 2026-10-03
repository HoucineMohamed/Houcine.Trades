# Houcine.Trades

Private trading workspace for one user: journal, stats, risk engine, AI analyst, and later
bots. **Foundation only**: it currently shows a placeholder page. Everything runs in **paper
mode**. Read `CLAUDE.md` for the rules and `docs/` for architecture and roadmap.

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
npm run dev
```

Open http://localhost:3000.

## Commands

| Command             | What it does     |
| ------------------- | ---------------- |
| `npm run dev`       | dev server       |
| `npm test`          | run tests once   |
| `npm run lint`      | ESLint           |
| `npm run typecheck` | TypeScript check |
| `npm run format`    | Prettier         |
| `npm run build`     | production build |

## Safety notes

- Never commit `.env`; only `.env.example` (placeholders) is tracked. The database (`data/`) is gitignored.
- Exchange API keys, when added, must be **trade-only with withdrawals disabled**.
- There is no real order execution. `TRADING_MODE` must be `paper`.
- Work on a branch and merge by pull request. On GitHub: Settings -> Branches -> add a rule for
  the default branch requiring a pull request and passing CI.
