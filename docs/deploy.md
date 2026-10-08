# Putting Houcine.Trades online (module 8): a beginner's guide

This guide takes you from "it runs on my computer" to "it runs online, all day, behind HTTPS and
my login, with encrypted backups stored somewhere else". Read it once from top to bottom before you
click anything. Nothing here needs you to read code.

> **Paper mode stays.** The hosted app can still only do paper trading. There is no order code in it.
> Hosting changes where it runs, not what it can do.

## 1. The picture

```
 your browser ──HTTPS──▶  Render (Frankfurt)
                          ┌────────────────────────────── one container ──┐
                          │  supervisor ─┬─ web app  (pages, your login)  │
                          │              └─ worker   (alerts + backups)   │
                          │  persistent disk  /var/data  (the database)   │
                          └───────────────────────────────────────────────┘
                                         │ every day, and before every database update
                                         ▼
                          encrypted backup ──▶ object storage in the EU (a different company)
```

- **Render** runs the app. It gives you HTTPS and a web address. Its disk keeps your database between
  deploys. Render also takes a snapshot of that disk every 24 hours: that is an **extra**, never a
  replacement for the backups below.
- **Backups** are made by the app itself, **encrypted on the server before they leave it** with a key
  that only you (and your password manager) hold, and stored **off the platform**, so losing Render
  does not lose your journal.
- **You** stay the only user. There is no sign-up page. You create yourself as the owner once, from
  a terminal on the server.

## 2. What I could and could not check (read this)

This module was built in a session that could not open Render's, AWS's or any storage provider's
websites. The facts you gave me from Render's documentation (a persistent disk exists only on paid
services, is used by one instance, is not there during build, prevents zero-downtime deploys, is
snapshotted every 24 hours, and there is SSH access as `SERVICE@ssh.REGION.render.com`) are used as
given. **Everything about prices, limits and exact button names below is from memory or from
third-party summaries, and must be confirmed on the dashboard (section 4).** What _is_ proven by
tests is listed in section 13.

## 3. What you must create and provide

| #   | What                                                | Where it comes from                             | Where it goes                                                       |
| --- | --------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| 1   | A Render account (turn on 2-step login)             | you                                             | -                                                                   |
| 2   | A spend alert / monthly budget                      | Render billing page (see 4.6)                   | -                                                                   |
| 3   | A GitHub account with 2-step login                  | you (already)                                   | Render is allowed to read this repository                           |
| 4   | An object-storage account (EU), 1 bucket            | you (section 5)                                 | the bucket name, endpoint, region and keys go to Render (#7)        |
| 5   | `BACKUP_KEY`                                        | `npm run backup:generate-key` on your computer  | **password manager first**, then Render                             |
| 6   | `AUTH_SECRET` - a **NEW** one                       | `npm run auth:generate-secret` on your computer | **password manager first**, then Render. Never reuse your local one |
| 7   | The settings                                        | section 7                                       | Render > the service > Environment                                  |
| 8   | An SSH key                                          | `ssh-keygen` on your computer                   | the public half (`.pub`) goes into Render account settings          |
| 9   | (optional) `ANTHROPIC_API_KEY`                      | the Anthropic console                           | Render environment (leave unset until you want the analyst)         |
| 10  | (optional) `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | see 7.3                                         | Render environment (leave unset until you want alerts)              |

**Never** paste a secret into this repository, a chat, an email, a screenshot or a support ticket.
Secrets live in your password manager and in Render's environment, nowhere else.

## 4. Facts to confirm on Render's dashboard BEFORE you click "Create"

Write down what you see. If something differs, **stop and tell me** instead of guessing.

1. **Region:** "Frankfurt (EU Central)" can be chosen for a web service from a Docker image/repository.
2. **Plan and price:** an always-on paid instance type (I expect "Starter", about 7 US dollars a
   month, 512 MB). Note the exact monthly price and that it does not sleep.
3. **Persistent disk:** you can attach one to this plan; note the price per GB per month (I expect
   about 0.25 US dollars) and the smallest size (1 GB is plenty to start). Note whether the size can
   be changed later and whether it can only grow.
4. **Mount path:** you can choose `/var/data`.
5. **Docker:** the service can be built from the `Dockerfile` in the repository root (runtime
   "Docker"), and the build has enough time and memory (the build compiles one native module).
6. **Spending control:** look for budget or spend notifications on the billing page. If there is no
   hard cap, put a monthly reminder in your calendar to look at the invoice. Total expected: about
   8 US dollars a month for Render, plus the storage below.
7. **Health check:** a "Health Check Path" field exists. You will set it to `/healthz`.
8. **Port:** the service must listen on the port Render gives it, on all addresses. The image does
   this (it reads `PORT`, default 10000). Note any port Render shows you.
9. **Auto-deploy:** there is a setting to deploy only **after CI checks pass** and a way to choose
   the branch. You will use branch **`Houcinemohamed`** (the default branch) and never a `claude/...`
   branch.
10. **Shell / SSH:** SSH is available for this service (you gave me the address form
    `SERVICE@ssh.REGION.render.com`). After section 8 step 8 check two things: that the shell
    **sees the service's environment variables** (so the owner script can find `AUTH_SECRET` and the
    database), and that it is a **real terminal** (the password prompt hides what you type).
11. **Disk ownership:** the container starts as root only long enough to give the app user ownership
    of `/var/data`, then runs as an ordinary user. If Render runs the image as a different user, the
    start-up check says "The persistent disk is mounted read-only" or similar: tell me.
12. **Client address:** Render adds the real visitor address to the **end** of the `X-Forwarded-For`
    header (it appends; it does not replace what a visitor sent). The app trusts only the **last**
    entry, never the first. Section 9 shows how to check what the app sees.
13. **Logs:** the service page has a Logs view. Note how long logs are kept.

## 5. Object storage for the backups

You need an **S3-compatible** storage service in the **EU**, with a **private** bucket. I have not
verified any provider's current prices from their own pages. Candidates (check each price page
yourself): Hetzner Object Storage, Backblaze B2 (EU region), Scaleway Object Storage. Your backups are
small (megabytes), so the monthly cost is cents to a few dollars on any of them; one provider's
minimum monthly charge may matter more than per-GB prices. It should be a **different company from
Render**, so that one account problem cannot take both the app and the backups.

Steps (the same for any provider, names differ):

1. Create the account and turn on 2-step login.
2. Create a **bucket**: private (no public access), in an **EU** region. Pick a name such as
   `houcine-trades-backups-<something unique>`.
3. Create an **access key** that is allowed to **read, write, list and delete only that bucket**.
   Write down the key id and the secret (it is shown once) - straight into your password manager.
4. Note the **endpoint** (an `https://...` address, no path after it), the **region** text, and the
   **bucket** name.
5. Switch on **versioning or object lock only if you understand it**: the app deletes old backups by
   its own retention rule and expects deletes to work. Plain buckets are fine.

The app talks to the storage with a small signing routine of its own (tested against Amazon's
published signing examples), using "path-style" addresses: `https://ENDPOINT/BUCKET/backups/...`.
If your provider insists on another address style, tell me before you deploy.

## 6. Make the two secrets on your computer

In a terminal on your own computer, in the project folder:

```
npm run backup:generate-key
npm run auth:generate-secret
```

Each prints one line of random text. **Copy each into your password manager right now, with a clear
name** ("Houcine.Trades BACKUP_KEY", "Houcine.Trades production AUTH_SECRET").

> **If you lose `BACKUP_KEY`, every backup becomes unreadable. Nobody can recover them, not me, not
> the storage provider.** Keep it in your password manager and ideally also printed in a safe place.

> The production `AUTH_SECRET` must be **new**, never the one in your local `.env`. It also protects
> the stored authenticator secret, so if you ever change it later you must re-enrol your authenticator
> (section 11).

## 7. The settings (Render > service > Environment)

Create each as an **environment variable** (use Render's "secret" option where it offers one).

### 7.1 Required

| Name                   | Value                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| `AUTH_SECRET`          | the new one from your password manager                                    |
| `BACKUP_KEY`           | from your password manager                                                |
| `TRUST_PROXY`          | `true` (the app refuses to start if this is not set to `true` or `false`) |
| `DATA_DIR`             | `/var/data`                                                               |
| `DATABASE_URL`         | `file:/var/data/houcine-trades.db`                                        |
| `S3_ENDPOINT`          | from section 5, starts with `https://`                                    |
| `S3_REGION`            | from section 5                                                            |
| `S3_BUCKET`            | from section 5                                                            |
| `S3_ACCESS_KEY_ID`     | from section 5                                                            |
| `S3_SECRET_ACCESS_KEY` | from section 5                                                            |

`HOSTED=true`, `NODE_ENV=production` and `PORT` are already set inside the image. `TRADING_MODE`
defaults to `paper` and the app refuses anything else.

The web server (the part that faces the internet) is started **without** `BACKUP_KEY` and the `S3_...`
settings: only the worker, which makes the backups, and the shell scripts get them. So a flaw in the web
server cannot hand over the means to read or delete your off-platform backups.

### 7.2 Optional

`S3_PREFIX` (folder inside the bucket, default `backups`), `SESSION_IDLE_MINUTES`,
`SESSION_ABSOLUTE_HOURS`.

### 7.3 The analyst and the alerts (leave for later)

The scripts `npm run ai:set-key` and `npm run notify:set-telegram` write a `.env` file, which does not
survive on the server. Use Render's environment instead:

- Analyst: add `ANTHROPIC_API_KEY` (and keep your spend limit in the Anthropic console).
- Alerts: run `npm run notify:set-telegram` **on your own computer** to create the bot pairing, then
  copy `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from your local `.env` into Render, and delete the
  token from your local `.env` if you do not need it there. Then switch alerts on in the app
  (Alerts page, with a fresh authenticator code).

## 8. Deploy, step by step

1. **Code on the default branch, CI green.** On GitHub, the pull request for this module has all
   checks green (`check`, `container`, `secret-scan`), and **you** merge it into the default branch
   `Houcinemohamed`. (I never merge for you and never deploy.)
2. **Render > New > Web Service**, connect your GitHub account, pick this repository and the branch
   `Houcinemohamed`.
3. Runtime **Docker**, region **Frankfurt**, instance type the always-on paid one you confirmed in
   section 4.
4. **Add a disk:** name `data`, mount path `/var/data`, size 1 GB.
5. **Environment:** add everything in section 7.1.
6. **Health Check Path:** `/healthz`.
7. **Auto-Deploy:** "After CI checks pass" (see 4.9). Do not point it at any other branch.
8. **Create Web Service.** The first build takes several minutes.
9. Open the **Logs**. A healthy first start shows, in this order, JSON lines containing:
   `release.migrated` (the database was created), then `boot.setup_mode` (there is no owner yet, so
   only the health check answers).
10. **Create the owner in the server's shell.** In Render, add your SSH public key (Account settings),
    then connect with the exact command Render shows (`ssh SERVICE@ssh.REGION.render.com`) and run:

    ```
    npm run auth:create-owner
    ```

    It asks for a password (hidden), shows a QR code for your authenticator app and gives 10 recovery
    codes. Save the codes in your password manager. There is no web page for this on purpose. (If the
    shell is logged in as root, the script first steps down to the app's own user, so every file it
    creates belongs to the app; it stops with a message if it cannot.)
    Within ten seconds the logs show `boot.owner_found` and then the web app and the worker start.

11. Open your service address (the `https://...onrender.com` link). You should see the sign-in page and,
    at the top of every page, **HOSTED, PAPER MODE**.

### If the container refuses to start

It prints exactly which rule failed (never a value) and waits 30 seconds before stopping, so the
platform does not restart it in a tight loop. The names:

| Log line                                                                              | Meaning                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `auth_secret`                                                                         | `AUTH_SECRET` is missing, too short, a placeholder, or not random enough                    |
| `trust_proxy_unset`                                                                   | `TRUST_PROXY` must be exactly `true` or `false`                                             |
| `trading_mode`                                                                        | `TRADING_MODE` must be `paper`                                                              |
| `data_dir`, `data_dir_not_mounted`, `data_dir_read_only`, `database_outside_data_dir` | the disk is not attached at `DATA_DIR`, or not writable, or `DATABASE_URL` points elsewhere |
| `backup_key`                                                                          | `BACKUP_KEY` is missing/malformed, or equal to `AUTH_SECRET`                                |
| `object_store`                                                                        | one of the `S3_...` values is missing or invalid                                            |
| `migrations_pending`, `owner_unreadable`, `migrations_unreadable`                     | the database could not be checked; see the log lines before                                 |

You can run the same checks yourself from the shell: `npm run host:check`.

## 9. Check that everything works

Do these once after the first deploy, and write the results down.

1. **Sign in** with your password and authenticator code. The **Security** page lists the sign-in.
2. **/healthz** (`https://YOUR-ADDRESS/healthz`) shows just `ok`. Nothing else.
3. **Backups page:** within a minute or two it changes from "Waiting for the first backup" to "The
   latest backup is verified and less than 36 hours old", with one row "daily - verified". Look in
   your storage bucket: a file whose name looks like `20261008T031500Z-daily-m7.htbk`. It is
   unreadable on purpose (encrypted).
4. **Cookie and HTTPS:** your browser shows the lock; the session cookie is `__Host-houcine_session`.
5. **What address does the app see?** From the shell run:

   ```
   node -e "const D=require('better-sqlite3');const d=new D(process.env.DATABASE_URL.replace('file:',''),{readonly:true});console.log(d.prepare('select kind, ip from auth_events order by id desc limit 5').all())"
   ```

   Sign in from your phone (mobile data) and then from your computer, and run it again: the `ip`
   values should be your **real, different** addresses. If you see the same internal address for
   both, or the word `unknown`, tell me (the per-source login limit would then treat all visitors as
   one - safe, but coarser).

6. **Alerts (if you set them up):** Alerts page > "Send test message".
7. **Restart test:** Render > Manual Deploy > Restart. The app comes back and your data is there.

## 10. The restore drill - do this BEFORE you trust the system

A backup you never restored is a hope, not a backup. Do the drill once now, then again after every
big change.

**Phase 1 - prove a backup can be read (changes nothing):**

```
npm run host:restore
```

It lists the backups, newest first. Choose number 1, then type `RESTORE` when asked. It downloads the
backup, decrypts it (a wrong `BACKUP_KEY` or a damaged file is refused), runs an integrity check and a
migrations check on a **new file**, and stages it. It prints "The backup is intact". Your running
database is **not touched**. A staged restore is applied at the **next start of the service**, so if
this was only a check, throw it away right away:

```
npm run host:restore -- --cancel
```

(A staged restore that is not applied within 6 hours is discarded by itself, so a forgotten one can
never replace your database weeks later.)

**Phase 2 - a full restore (do this once, with nothing important in the journal yet):**

1. Do Phase 1 for the backup you want.
2. Render > Manual Deploy > **Restart**. At the start, before anything opens the database, the staged
   file replaces the live one. The old database is **kept** next to it, in files whose names contain
   `.before-restore-` (it is never deleted for you; delete those files yourself once you are satisfied,
   because they hold your whole journal in readable form).
3. The logs show `boot.restore_applied`. **A restore puts a copy of the past in place, so for your
   safety the app then ends every session and halts every account** ("Precautionary halt after a
   restore from a backup"). Sign in again with your password and authenticator code, check your
   trades and limits (anything done after the backup time is not in the restored file, including a
   halt that began after it), and only then reset the halts on the Risk page (that needs a fresh
   code on purpose). If you restored because someone got in, also run `npm run auth:reset`: the
   restored file brings back the old password and authenticator too.
   If a staged restore could **not** be applied (the file changed, failed its check, or came from a
   newer version), the database in use stays as it was, and the Backups page and the header say
   "Restore not applied" until you run `npm run host:restore -- --cancel`.
4. If the restored backup is from an older version of the app, the start also takes a new verified
   backup and applies the newer database updates.
5. **If you see `boot.database_missing_backups_exist` in the log**, the disk has no database but your
   bucket holds backups (a typo in `DATABASE_URL`, a deleted file, a new empty disk). Do **not** create
   an owner: run `npm run host:restore` first.

**Prove your password-manager copy of `BACKUP_KEY` works:** the key in Render and the key in your
password manager must be identical. Open both and compare them character by character once. A backup
made today can only be opened with that exact key.

## 11. Every release (the checklist)

1. All checks green on the pull request (`check`, `container`, `secret-scan`). **Never** deploy a
   `claude/...` branch.
2. You merge into `Houcinemohamed`. Render deploys after the checks pass.
3. On start, the **release step** runs by itself: if there are new database updates it first makes a
   **verified backup** ("pre-migration"), then applies them. If the backup or an update fails, the
   container does **not** start, the old database is untouched, and a notice is attempted (alerts, if
   on). The log says `release.backup_failed` or `release.migration_failed`. **The log is always the
   signal you can rely on:** a release that crosses migration 0006 (or any later one that adds
   notification kinds) starts from a database that cannot yet record such a notice, so nothing is
   queued for your phone in that one case.
4. Check: `/healthz` is `ok`, the Backups page is healthy, the Alerts page shows "A database update was
   applied" (if alerts are on).
5. **Rollback:** (a) redeploy the previous version on Render; (b) if the data must go back too, run
   `npm run host:restore`, choose the "pre-migration" backup made just before, type `RESTORE`, then
   Restart (section 10, phase 2).

## 12. Logs, leaks and stopping

### Reading the logs

Render > the service > **Logs**. Each line is one JSON object: `ts`, `level`, `service`
(`supervisor`, `web`, `worker`, `backup`), `event` and a few counts. Words worth searching for:
`boot.refused`, `release.migrated`, `release.backup_failed`, `release.migration_failed`,
`backup.ok`, `backup.failed`, `child.crashed`, `child.heartbeat_stale`, `supervisor.giving_up`.
Everything the app prints passes through a redactor first; a test proves that no secret, token,
cookie, address with credentials or request body appears. **Do not** paste logs anywhere public
without reading them first.

### If a secret leaks

| Secret                   | What to do                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_SECRET`            | Make a new one, put it in Render, then in the shell run `npm run auth:reset` (the old secret protected your stored authenticator; you must re-enrol). All sessions end.                                                                                                        |
| `BACKUP_KEY`             | Make a new one, put it in your password manager and Render, restart (a new backup is made with it). Keep the old key until a new backup is verified, then delete the old backups from the bucket. Anyone with the old key **and** access to the bucket could read old backups. |
| Storage access key       | Revoke it at the storage provider, make a new one, update Render. Check the bucket for files you did not make.                                                                                                                                                                 |
| Telegram token           | In Telegram open @BotFather, revoke the token, run `npm run notify:set-telegram` again, update Render.                                                                                                                                                                         |
| Anthropic key            | Revoke it in the Anthropic console, make a new one, update Render.                                                                                                                                                                                                             |
| Render or GitHub account | Change the password, turn on 2-step login, check active sessions and deploy keys, then treat **every** secret above as leaked.                                                                                                                                                 |
| Your password / phone    | `npm run auth:reset` in the shell.                                                                                                                                                                                                                                             |

### Stop everything

1. Make a last backup: in the shell `npm run host:backup`.
2. Render > the service > **Suspend** (stops it; check on the billing page whether the disk keeps
   costing) or **Delete** it (this deletes the disk and its snapshots).
3. If you are leaving for good, delete the objects and the bucket at the storage provider and revoke
   the keys. Keep one copy of the last backup **and** its `BACKUP_KEY` if you may want the journal back.

## 13. What is proven, and what is not

**Proven by tests that run in every `npm test` (no network, no account):**

- Start-up rules: each missing or invalid setting refuses to start and nothing is spawned or
  touched (secrets, paper mode, proxy setting, disk mounted and writable, database inside the disk,
  backup key, storage settings, owner, pending migrations).
- The release step: verified backup first, migration second; a failing backup or migration leaves the
  old database exactly as it was and starts nothing.
- Backups: consistent snapshot, encryption before upload (the stored file contains no readable text),
  upload, read-back verification; a corrupted object, a truncated upload, an upload the provider
  silently dropped, a wrong key, a damaged file and an object swapped for another backup (the name is
  authenticated) are all detected; the plaintext snapshot and its side files are removed when the
  backup ends, and any left by a hard kill are swept at the next start.
- Retention: a random-input test proves the newest backup and the newest of each kind are never
  deleted; files that are not ours are never touched; a failed listing deletes nothing.
- Restore: into a new file, integrity and migrations check, swap only at start with the app closed,
  the old database kept; a backup from an older schema works; a backup from a newer app is refused.
- The signing routine matches Amazon's published signing examples.
- Supervisor: restart on crash with growing pauses, a bounded crash loop, a clean SIGTERM shutdown, a
  hung worker killed and restarted.
- Client address: forged `X-Forwarded-For` entries and other address headers are ignored; hosted
  cookies are `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-`; HSTS on every hosted response.
- `/healthz` is public, answers only `ok` / `not ok`, and is on the allowlist in the discovery test.
- Logs: a redaction test feeds secrets, tokens, cookies and credentialed URLs and finds none.
- The secret scan covers all new files, including this guide.

**Proven by the container smoke test (`scripts/ci/container-smoke.sh`, run in CI and run once on the
build machine for this module):** the image builds, contains no `.env`/database/data/tests/dev
dependencies (decoy files are planted and must be absent), refuses to start without secrets (exit
78), applies migrations on a fresh volume, stays in setup mode without an owner, starts the web app and
the worker once an owner exists, runs as a non-root user, sends HSTS, redirects `/` to `/login`, logs
no secret, stops cleanly on SIGTERM and restarts on the same volume with the data kept.

**Not proven (needs your first deploy):** anything specific to Render (prices, the shell showing the
environment and a real terminal, the disk's ownership, the exact header it appends, how it restarts a
failing container); a real upload to your chosen storage provider (the signing routine is tested
against Amazon's examples, but each provider has its own quirks - the first backup is the live test);
the Telegram delivery (see `docs/notifications.md`).

## 14. Honest limits

- **One instance, one writer.** SQLite on one disk. A deploy or restart means a short gap (no
  zero-downtime deploys with a disk).
- **Backups are daily**, so up to a day of entries can be lost in the worst case. The "pre-migration"
  backup protects every database update. You can make one any time with `npm run host:backup`.
- **At-least-once alerts**, as before.
- **The restore needs a restart** by design: it is never swapped under a running app.
- **If the container cannot make its pre-migration backup it will not start.** That is deliberate
  (fail closed). Fix the storage settings and redeploy.
- A person who can run commands in the shell can read `AUTH_SECRET` from the environment. Protect your
  Render and GitHub accounts like the app itself.
