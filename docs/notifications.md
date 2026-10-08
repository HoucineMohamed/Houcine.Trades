# Alerts (module 7): phone notifications for events inside the app

This page is written for a beginner. Read the first two sections even if you skip the rest.

## What alerts are and are not

Alerts send a short message to your phone (through Telegram) when something important happens
**inside this app**: a limit getting close, a halt, a sign-in, a failed analyst call.

- Alerts are **one-way**. The app sends; Telegram never sends anything back that the app obeys. There
  is no remote kill switch, no remote confirm, no webhook and no listening bot. Whatever you type to
  the bot is ignored.
- Alerts **never block anything**. If Telegram is down, the token is wrong or the worker is stopped,
  trades, halts, risk checks and sign-ins work exactly as before.
- Alerts are **off** until you switch them on, read the consent text and enter a fresh authenticator
  code.
- Alerts are about this app only. There are no price or market alerts (no market data exists yet).

## What events are announced

| Group    | Event                                                                                      | Strength                                     |
| -------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Risk     | a limit used 50 %, 80 % or 100 % (daily loss, open risk, open trades, drawdown)            | info, warning, critical                      |
| Risk     | a halt started (daily loss, drawdown, by hand)                                             | critical, critical, warning                  |
| Risk     | a halt ended                                                                               | info                                         |
| Risk     | a refused drawdown reset, an override, a trade that breaks a rule logged                   | warning                                      |
| Security | repeated failed sign-ins (one summary per 15 minutes), a throttle started                  | warning                                      |
| Security | a successful sign-in                                                                       | info                                         |
| Security | a recovery code used                                                                       | critical                                     |
| Security | password or security settings changed, "sign out everywhere", a failed fresh-code check    | warning                                      |
| Analyst  | a cap at 80 % or 100 %, a failed call                                                      | warning, info                                |
| System   | "Alerts were switched off" (one last message), a test message, "N more events are waiting" | critical, info, info                         |
| System   | backup failed, market data out of date                                                     | reserved: defined, nothing produces them yet |

Events are **derived** from records that already exist (the risk log, the sign-in log, the analyst usage
log) and from the limits' current usage. Nothing inside the risk, sign-in or analyst code sends them.
When you switch alerts on, only things that happen **from that moment** are announced.

Each limit level is announced once per period: the daily loss limit once per UTC day; the others once
per crossing, again only after usage falls below that level and rises again, and never twice within an
hour.

## What a message can contain

Messages are fixed sentences. The only things that vary are the kind of event, a level (50, 80 or
100), a count and an account **number**. For example:

```
Houcine.Trades (paper): Daily loss limit: 80 % of the limit is used (account #1).
Houcine.Trades (paper): Trading is halted: the daily loss limit was reached (account #1).
Houcine.Trades (paper): 4 failed sign-in attempts within 15 minutes.
```

A message **never** contains notes, emotions, setup names, symbols, account names, balances, amounts,
prices, keys, tokens, passwords, emails or IP addresses. Tests with seeded hostile data check this.
Messages are plain text: no links, no formatting, no buttons.

Telegram's servers carry the messages, and chats with a bot are **not end-to-end encrypted**, so
Telegram can read them. That is why nothing sensitive is ever in them.

## Setting it up, step by step

1. **Create a bot.** In Telegram, open the chat with @BotFather, send `/newbot` and follow the
   questions. BotFather gives you a **token** (a long text with a colon in it). Keep it private: anyone
   with it can control that bot.
2. **Start your bot.** Open your new bot in Telegram and press **Start** (a bot can only write to you
   after you started it).
3. **Run the setup script** in a real terminal window:

   ```
   npm run notify:set-telegram
   ```

   It asks for the token with hidden input (nothing shows as you paste), writes it into `.env` (which
   git ignores) and shows only the last 4 characters. Then it shows a **one-time code**. Send exactly
   that code to your bot in Telegram. The script listens for a limited time, accepts only a private
   chat message with that exact code, and shows the last digits of the chat so you can confirm. It
   ignores everything else.

4. **Open the Alerts page** (`/notifications`). Status should say Telegram is set up.
5. **Switch alerts on:** read the consent text, tick the box, type a current authenticator code,
   press "Turn ON".
6. **Send a test message** with the button. It should arrive on your phone.
7. **Start the worker** so events are collected and delivered all the time:

   ```
   npm run notify:worker
   ```

   It runs until you press Ctrl+C. Every 30 seconds it collects new events and delivers what is waiting.
   Without the worker, press **Deliver now** on the page. (A later module will run the worker as a
   service.)

## The settings

- **Category switches and minimum severity.** Switching a category on, or lowering the minimum
  severity, applies at once. Switching a category off, or raising the minimum severity, needs a fresh
  code and takes effect after 24 hours; asking for the louder setting again cancels it at once.
- **Critical events can never be switched off** while alerts are on.
- **Switching alerts off** needs a fresh code, takes effect at once and sends one last message,
  "Alerts were switched off".
- Every change is written to the sign-in log (`auth_events`), which you can read on the Security page.

## Why quieter settings wait 24 hours

Someone who got into an open session could try to silence the alerts that would expose them. A change
that makes alerts quieter therefore needs a fresh code and waits 24 hours, the same rule that applies
to loosening a risk limit. You can still cancel it at once by asking for the louder setting again, and
critical events are never held back by these settings.

## Flood protection

At most 20 messages an hour go out, plus 10 more that only critical events may use (so never more than
30). If more events wait, one summary message says "N more events are waiting" (at most one per hour)
and the rest stay in the outbox and are delivered as soon as there is room. Events are never dropped
because of the ceiling.

## When delivery fails

Every event is recorded first; delivery comes second. A failed delivery is retried after 1, 2, 4, 8 and
16 minutes, then every 30 minutes, for up to 24 hours. After that the event is marked expired: it is
never sent, but it stays on the Alerts page. Every attempt is logged with a short code such as
`network` or `forbidden` (never free text). If the worker stops between sending and recording, one
message may arrive twice: that is chosen over ever losing one.

A message that was claimed for sending but never got a result (the worker died mid-send) counts as
failed after 10 minutes and is retried.

## How you find out that alerts are not working

The worker writes a "last ran" time after every cycle. The Alerts page and the header warn you when
alerts are on and any of these is true:

- the worker has not run in the last 90 seconds, or never since you switched alerts on (start it with
  `npm run notify:worker`);
- Telegram is not set up, or the last three delivery results failed, or an event has been failing for
  15 minutes;
- an event of the last 7 days expired without ever being sent;
- the stored settings or part of the app state could not be read in the last cycle.

The header shows "Alerts: not getting through" in those cases, and "Alerts: status unknown" when the
health itself cannot be read. Silence is never shown as "fine" when the state is unknown. Switching
alerts on is refused while part of the current state cannot be read (it could not start from a known
point). Switching on when alerts are already on does nothing.

Sign-in failure bursts are announced at counts 3, 10, 30 and 100 within a 15-minute window, so a
growing attack is not hidden behind the first message. "Send test message" works at most once a minute.

## If the token leaks

1. In Telegram, open @BotFather and **revoke the token** of that bot (send `/revoke` and choose the
   bot; BotFather gives a new token).
2. Run `npm run notify:set-telegram` again and enter the new token.
3. Restart the worker.
4. Find out how it leaked (a screenshot, a chat, a commit?) and remove it there too.

## To confirm on first live test

The coding session could not read Telegram's official documentation (the network blocked it), so these
points come from memory or from search-result excerpts and are **not confirmed**. The code treats any
unexpected answer as a failure and never guesses. On your first real run, check each one:

1. The address form `https://api.telegram.org/bot<TOKEN>/sendMessage` and `.../getUpdates`, called with
   a JSON POST body.
2. A successful reply is `{"ok": true, "result": {...}}`, and for `sendMessage` the result is an object.
3. An error reply has `ok: false` and an `error_code`; 401 means a bad token, 403 a blocked or
   not-started bot, 409 a conflict (for example a webhook is set), 429 a rate limit with
   `parameters.retry_after` in seconds.
4. `getUpdates` takes `offset` (confirms every update below it), `timeout` (long polling, in seconds)
   and `allowed_updates`, and returns updates shaped like `{update_id, message: {chat: {id, type},
text}}`. **If your bot has a webhook set, `getUpdates` fails**: pairing then stops with a plain
   message.
5. A bot can only write to a user who pressed Start.
6. A private chat id is a positive whole number (groups are negative; the app refuses groups).
7. A bot token looks like digits, a colon, then about 35 letters and digits (the setup script rejects
   anything else).
8. Messages up to 4096 characters are accepted (our messages are far shorter). About one message per
   second to one chat is the advised pace (the worker waits 1.1 seconds between messages).
9. Chats with a bot are not end-to-end encrypted (the consent screen says so, as you asked).
10. `/newbot` and `/revoke` are the right BotFather commands.

Seen only in search excerpts of the official pages (not read directly): the 4096-character limit, the
`timeout` and `allowed_updates` fields of `getUpdates`, `retry_after`, the pace limits and revoking a
token with BotFather.

## For developers

- `src/domain/notifications/`: pure code: events, usage levels, fixed message templates, the outbox
  policy and the settings rules. Tests beside it.
- `src/integrations/telegram/`: the channel interface, the `fetch` adapter (every error becomes a short
  code, never a URL: the token is inside the URL) and lazy validation of `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHAT_ID`. `tests/helpers/notifications.ts` has the fake channel and fake updates.
- `src/notifications/`: the collector, the delivery service, one worker cycle. None of it is called from
  a trade, a halt, a risk check, a sign-in or the analyst (a test checks the imports).
- `src/data/notifications.ts` and the tables `notification_events`, `notification_deliveries`,
  `notification_settings`, `notification_state` (migration `0005`; the two logs are append-only through
  triggers and store short codes only).
- Out of scope: price or market alerts, inbound commands or webhooks, other channels, deployment, bots,
  order execution.
