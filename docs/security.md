# Security (module 4: authentication)

Plain-language guide to every protection in the app and why it exists. The app is for ONE owner
(you). It still runs on your own computer only (`127.0.0.1`); this module makes it safe to host
later (module 8), but **nothing here configures hosting**.

## The short version

- You sign in with your **password + a 6-digit code from an authenticator app**.
- There is **one owner**, created on the command line. There is no sign-up page and no
  "forgot password" page on the web.
- **Every page, action and route checks your session itself.** A test fails if any does not.
- Dangerous actions ask for a **fresh code** (entered in the last 5 minutes).
- Wrong guesses are **slowed down** (never a permanent lockout).
- There is **no bypass**: no `AUTH_DISABLED` switch, no default password, no secret in the code.

## What is protected, and how

| Protection                   | What it does                                                                                                                                                                                                                                                                                  | Why                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Password (argon2id)          | Hashed with argon2id (64 MiB, 3 passes), minimum 12 characters, common passwords refused (zxcvbn score 3+).                                                                                                                                                                                   | A stolen database must not reveal passwords; argon2id is deliberately slow and memory-hungry for attackers. |
| Authenticator code (TOTP)    | 6-digit code, changes every 30 s, one step of clock drift allowed. A code can be used **once** (replay protection, enforced atomically in the database).                                                                                                                                      | A stolen password alone is useless.                                                                         |
| TOTP secret encrypted        | Stored with AES-256-GCM, key derived (HKDF) from `AUTH_SECRET`.                                                                                                                                                                                                                               | A stolen database file alone cannot produce codes.                                                          |
| Recovery codes               | 10 single-use codes, stored only as SHA-256 hashes (they are 80-bit random, so a plain hash is enough). Using one ends all other sessions.                                                                                                                                                    | You can still get in if your phone is lost.                                                                 |
| Server-side sessions         | The cookie holds a random 256-bit token; only its hash is stored. Idle timeout 2 h, absolute 12 h (configurable, with limits). A new session on every login; logout destroys it.                                                                                                              | A stolen database cannot be used to hijack a session; stolen cookies expire.                                |
| Cookie flags                 | `HttpOnly` (scripts cannot read it), `SameSite=Strict` (never sent from other sites), `Secure` + `__Host-` prefix over HTTPS.                                                                                                                                                                 | Blocks theft by scripts and cross-site use.                                                                 |
| Guard on every entry point   | `guardedPage`, `guardedAction`, `guardedRoute` in `src/app/_lib/`. The database is reachable from the UI only through them (ESLint forbids importing it).                                                                                                                                     | "Forgetting the check" cannot reach data.                                                                   |
| `proxy.ts`                   | First cheap line: sends visitors without a cookie to `/login`, refuses cross-site posts, adds security headers. **Not** relied on alone.                                                                                                                                                      | Defence in depth: a proxy bypass still hits the real check.                                                 |
| Coverage tests               | `tests/auth/guard-coverage.test.ts` finds every page, route handler and server action and fails if one is unguarded; `guard-dynamic.test.ts` calls each one without a session and with a forged cookie.                                                                                       | New code cannot silently skip protection.                                                                   |
| Step-up (fresh code)         | A code entered in the last 5 minutes is needed to: loosen a risk limit, reset a halt (drawdown or manual), restore default risk settings, log an **override**, change the password, regenerate recovery codes, log out everywhere. Starting a manual halt (the kill switch) stays one click.  | A stolen session cannot loosen your safety rules.                                                           |
| Proof type `FreshAuth`       | The sensitive data functions require a `FreshAuth` value that only `src/auth` can create (it cannot be forged).                                                                                                                                                                               | Later modules cannot forget the check. **Module 9 (real orders) must require it too.**                      |
| CSRF                         | The `Origin` header must match the `Host` header on every state-changing request (plus `Sec-Fetch-Site`, plus `SameSite=Strict`, plus Next.js' own server-action check).                                                                                                                      | Other websites cannot make your browser act as you.                                                         |
| Security headers             | CSP with a per-request nonce (no inline scripts, no inline styles), `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cache-Control: no-store`, HSTS over HTTPS.                                                                     | Limits what an injected script could do, stops framing and caching of private pages.                        |
| Rate limiting                | Per source: 4 free failures, then 5 s, doubling, capped at 15 min. All sources together: 20 free, then 5 s doubling to 5 min. Stored in SQLite, so a restart does not reset it. Requests that arrive during a delay are **not counted**, so an attacker cannot make the delay longer for you. | Makes guessing impractical; you can never be locked out for good.                                           |
| Generic errors, equal timing | One message for every wrong credential; a real or dummy argon2 check always runs; comparisons are constant time.                                                                                                                                                                              | Does not reveal what is wrong or whether an owner exists.                                                   |
| Audit log                    | `auth_events` is append-only (database triggers). Never contains passwords, codes, tokens or secrets. Shown on `/security`.                                                                                                                                                                   | You can see what happened.                                                                                  |
| One owner at the database    | The `owner` table accepts only row id 1 and cannot be deleted.                                                                                                                                                                                                                                | Even a bug cannot create a second user.                                                                     |
| Secret scanning              | A test scans tracked files for real-looking secrets on every `npm test`; `.gitleaks.toml` and an optional pre-commit hook are provided. See "gitleaks" below.                                                                                                                                 | Rule 1: no secrets in git.                                                                                  |

## Setting it up (the owner is created on the command line)

See the README, "Create the owner". In short: generate `AUTH_SECRET`, put it in `.env`,
run `npm run db:migrate`, then `npm run auth:create-owner`. The command asks for your password
(hidden, never an argument), then shows the authenticator QR code, the secret and the 10 recovery
codes **once**. Nothing is shown again.

`npm run auth:reset` replaces the password and the authenticator and issues new recovery codes. It
needs a real terminal on the machine that holds the database (so it is not reachable from the
web) and ends every session.

## `AUTH_SECRET`

- Generate: `npm run auth:generate-secret`. At least 32 characters, random. The app refuses to
  start sign-in with a short, low-variety or placeholder value.
- It lives only in `.env` (gitignored). **Back it up** (password manager). If it is lost, the
  encrypted authenticator secret cannot be read: run `npm run auth:reset` to re-enrol. Recovery
  codes still work, because they do not depend on it.
- Changing it has the same effect as losing it.

## Step-up: how it feels

A sensitive form shows an "Authenticator code" box. Type the current code and submit. A code that
is accepted unlocks sensitive actions for 5 minutes (the box then says so). Signing in counts as a
fresh code. A code works once, so after signing in wait for the next code if the box asks again.

## Dependencies added (vetted, rule 8)

All MIT-licensed, no install scripts, native code only in `@node-rs/argon2` (prebuilt binaries
from the same project).

| Package                                             | Used for                                                   |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `@node-rs/argon2` 2.2.1                             | argon2id password hashing                                  |
| `otpauth` 9.5.2 (+ `@noble/hashes`)                 | TOTP (tested against the RFC 6238 vectors)                 |
| `@zxcvbn-ts/core`, `language-common`, `language-en` | password strength                                          |
| `uqr` 0.1.3                                         | QR code in the terminal (no network, no image)             |
| `server-only` 0.0.1                                 | makes importing server code into the browser a build error |
| `tsx` 4.23.15 (dev)                                 | runs the command-line scripts                              |

## gitleaks (secret scanning in CI)

CI has a `secret-scan` job (`.github/workflows/ci.yml`). It installs the official gitleaks program
(MIT) with `go install`, pinned to the exact version **v8.30.1**, using `actions/setup-go`. Go's
checksum database verifies the module and stays enabled. It then scans the whole git history with
`.gitleaks.toml` and fails on any finding.

Note on the module path: gitleaks lives under the `gitleaks` GitHub organization, but its `go.mod`
for v8.30.1 still declares the old path `github.com/zricethezav/gitleaks/v8`, so Go refuses
`go install github.com/gitleaks/gitleaks/v8@v8.30.1`. The job therefore uses the old path, which
serves the same code at the same version.

Other protections that exist alongside it:

- `tests/security/secret-scan.test.ts`: runs on every `npm test`, scans tracked files for private
  keys, cloud/GitHub/Slack/Anthropic-style keys, JWTs and secret-looking assignments. Its own
  detector is tested with deliberately fake secrets.
- `.gitleaks.toml`: the only exceptions are the `.env.example` placeholder and the public RFC 6238
  test secret (in the two test files that mention it).
- `.githooks/pre-commit` (optional): runs gitleaks on staged changes if you have it installed.
  Enable once with `git config core.hooksPath .githooks`. It never installs anything.

**The job must be green before any real API key is used** (roadmap).

## The analyst and its API key (module 6)

Plain-language version: `docs/analyst.md`. The protections, all tested:

- `ANTHROPIC_API_KEY` lives only in `.env` (git ignores it), set by `npm run ai:set-key` (hidden
  input, real terminal only, never an argument, never printed beyond the last 4 characters). It is
  validated lazily; builds, tests and the db commands need none. A missing or placeholder key means
  the analyst is off.
- The key goes only into the `x-api-key` header of one fixed HTTPS URL. It is never logged, never in a
  page, an error message, a stored record or a result; tests scan all of those (including a provider
  that echoes the key back).
- The model call has no tools. A hostile note cannot change the structure of the request, the
  verdict, a setting or a stored value, and a reply with extra fields is rejected as a whole.
- Privacy switch OFF by default; ON needs a fresh authenticator code and is logged. Raising a spend
  cap needs one too and waits 24 hours.
- Keep a monthly spend limit in the Anthropic console: it is the real hard stop.
- Known limits: text you type in notes goes to Anthropic once the switch is on (emails, key-like text
  and long numbers are masked first, but masking is not perfect); the first real API call was not
  tested live in the build session; the usage cost is an estimate.

## Alerts and the Telegram token (module 7)

Plain-language version: `docs/notifications.md`. The protections, all tested:

- The channel is one-way: no webhook, no listening bot, no remote command. Incoming messages are read only
  during the one-time pairing, and only the exact one-time code from a private chat is accepted.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` live only in `.env`, set by `npm run notify:set-telegram`
  (hidden input, real terminal only, never an argument, last 4 characters shown, refuses if `.gitignore`
  does not cover `.env`). Validated lazily; placeholders and group chat ids are rejected.
- The Bot API puts the token inside the request URL, so the adapter never logs, stores, throws or returns a
  URL, a request or a raw fetch error: every failure becomes a short code (`network`, `forbidden`, ...). A
  test feeds it errors that contain the URL and scans the database, console, results and pages.
- A notification never contains notes, emotions, setup names, symbols, account names, balances, amounts,
  prices, keys, tokens, passwords, emails or IP addresses (fixed templates; golden and hostile-data tests).
- The master switch is OFF by default; ON needs the consent screen and a fresh code, OFF needs a fresh code
  too, and quieter settings wait 24 hours (so an intruder cannot silence alerts quickly). Critical events
  cannot be switched off. Everything is logged in `auth_events`.
- A notification failure can never block a trade, a halt, a risk check or a login: nothing in those paths
  imports the notification code.
- Known limits: messages pass through Telegram's servers and bot chats are not end-to-end encrypted (so
  nothing sensitive is ever in them); delivery is at-least-once; the first real Telegram call was not tested
  and some Telegram facts are unconfirmed (see `docs/notifications.md`).

## What module 8 (hosting) must do

This module does not configure hosting. Before exposing the app:

1. **HTTPS only**, with a certificate (reverse proxy such as Caddy or nginx). The app then sets
   `Secure`, the `__Host-` cookie name and HSTS by itself when it sees HTTPS.
2. Put the app behind that proxy, bound to `127.0.0.1`; the proxy forwards `Host`, `X-Forwarded-For`
   and `X-Forwarded-Proto`. Only then set `TRUST_PROXY=true` in `.env` (otherwise an attacker could
   forge their address and dodge the per-source limit). The proxy must **overwrite**, not append
   to, `X-Forwarded-*` headers from the internet, and must preserve the `Host` header.
3. Back up the SQLite file **and** `AUTH_SECRET` (separately; the file alone cannot be used to
   sign in or to read the authenticator secret).
4. Keep `.env` readable only by the app's user. Never put secrets in the repository.
5. Think about a second pair of eyes: GitHub branch protection, 2FA on the GitHub account and on the
   hosting account.

## Known limits (honest list)

- Anyone who has your **password, your phone and the database file with `AUTH_SECRET`** can sign
  in. That is the point of multiple factors; guard the phone and the server.
- Rate limiting without `TRUST_PROXY` treats every visitor as one source (the global limit still
  applies). That is fine on localhost; module 8 must set it up properly.
- An attacker who can run code on the server can read `AUTH_SECRET` from the environment. Host
  hardening is module 8's job.
- No passkeys, no multiple users, no email or SMS: out of scope by design.
- The risk engine, journal and stats are unchanged by this module; only who may use them changed.
