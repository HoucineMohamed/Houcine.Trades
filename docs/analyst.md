# The analyst (module 6): an AI that reviews and explains

This page is written for a beginner. Read the first two sections even if you skip the rest.

## What it is, and what it is not

The analyst is Claude, an AI, used as a **journal coach**. It reads what you give it (a trade plan,
your closed trades of a week, a question) and writes a plain-language review.

- It **reviews and explains**. It never decides.
- It **cannot approve or refuse a plan**. The risk engine does that, and its verdict is always shown
  first. The analyst's text is labelled **"AI commentary, not advice; the risk engine decides"**.
- It **cannot change** a plan, a limit, a halt, a setting or a trade. It cannot place an order.
- It has **no tools**: it receives text and returns text. It cannot reach your database, your keys,
  the internet or your files.
- It **does no maths**. It may only quote numbers that were in what you sent. Every number it
  quotes is checked (see "Reading an answer").
- It can be wrong. It is a second pair of eyes, not an authority.

The app works exactly the same without it. No key means the analyst is simply off.

## The three features

1. **Plan review** (on the New trade page). After the risk engine shows its verdict, an
   "Ask the analyst" button appears. You get a plain explanation, questions a careful trader would
   ask, and any points that conflict with your own saved rules or the verdict. It will not tell you
   to open, close, size up or ignore a limit.
2. **Weekly review** (`/analyst/review`). Pick an account, a date range and ONE currency. You get
   observed patterns, recurring mistakes, rule-breaking (overrides), what the data cannot show
   (including the small-sample warning) and neutral questions for next week.
3. **Tutor** (`/analyst/tutor`). Ask about a concept ("What is expectancy?"). It teaches, using your
   own numbers as examples. No predictions, signals or advice on what to trade.

Every answer is stored (`/analyst`, "History"), so you can read it again without paying twice. If
you ask exactly the same thing again, you get the stored answer and nothing is sent.

## What is sent, and what never is

Sent, only when you press an "Ask" button and only if the privacy switch is ON:

- the plan or the closed trades you picked, with prices and sizes
- the statistics and the risk engine's verdict and numbers
- your notes, emotions and setup names (emails, key-like text and long digit strings are masked first)
- the questions you type

**Never sent:** API keys, your password, authenticator codes or secrets, session data, account
names or numbers.

The text goes to Anthropic (the company behind Claude) over HTTPS. Read their privacy terms before
you turn the switch on.

## Setting it up, step by step

Do these in order. Do not skip step 3.

1. **Check the repository is safe.** Your CI "secret-scan" (gitleaks) job must be green before any
   real key exists. It cannot be run from the coding session, so look at the checks on GitHub.
2. **Create a developer account** in the Anthropic Console (platform.claude.com) and add a small
   amount of credit or a payment method.
3. **Set a monthly spend limit BEFORE you create a key.** In the Console, open the settings or
   billing area and look for **Limits** (menu names can change; search the Console help for
   "spend limits"). Choose an amount you are happy to lose, for example 5 US dollars. This limit is
   the **real hard stop**: even if this app had a bug, Anthropic stops charging at that amount.
4. **Create an API key** in the Console (name it, for example, `houcine-trades`). The Console shows
   the key **once**. Do not paste it in chat, in a file in this project, in an email or in a
   screenshot.
5. **Put the key in your `.env` file with the script**, in a real terminal (not a pipe):

   ```
   npm run ai:set-key
   ```

   It asks for the key with hidden input (nothing appears as you paste), checks its shape, writes
   `ANTHROPIC_API_KEY` into `.env` (which git ignores) and shows only the **last 4 characters** to
   confirm. It refuses to run with the key on the command line, and refuses to run without a real
   terminal.

6. **Restart the app** (stop `npm run dev` and start it again) so it reads the new key.
7. **Open the Analyst page** (`/analyst`). Under Status you should see "API key: set (it is never
   shown)" and the model name.
8. **Turn the privacy switch ON.** Read the list of what is sent and what is not, tick the box, type
   a current authenticator code and press "Turn ON". It starts OFF. You can turn it OFF again at any
   time without a code.
9. **Try a cheap first question** in the Tutor, for example "What is expectancy?". Then look at the
   Usage section and compare with the Usage page in the Anthropic Console after a few minutes.

### First real call (honest note)

The code was tested only against a fake client, because the coding session has no key and no
network. The request follows the current official documentation, but your first real call is the
first time it meets the real service. If it fails, the page shows a plain message such as
`HTTP 400 invalid_request_error ... (request id req_...)`. Nothing else breaks, and the failure is
logged. Send that line (never the key) to whoever maintains the code.

## Cost, caps and the real hard stop

- Each call costs a few cents at most (a plan review about 1 cent, a weekly review about 3 cents
  with the default model, in the author's estimate).
- The app keeps its own **caps**: calls per day (default 20, ceiling 100), calls per month (default
  200, ceiling 1000) and estimated cost per month (default 5 USD, ceiling 25 USD). The ceilings are
  in the code and cannot be raised from the web. Day and month follow the **UTC** calendar.
- **Lowering a cap applies at once. Raising one waits 24 hours and needs a fresh authenticator
  code**, the same rule as your risk limits.
- When a cap is reached, the analyst stops until the period resets. The rest of the app is not
  affected.
- The cost shown is an **ESTIMATE**: the app multiplies the tokens Anthropic reports by a price
  table in `src/domain/analyst/pricing.ts` ("last verified" date at the top). **The spend limit you
  set in the Anthropic console is the real hard stop.**
- Before each request the app also checks that the worst case of that single request still fits
  under the monthly cost cap.
- There is **no automatic retry**: one request, one answer, or a plain failure. A request that
  times out is counted at its worst-case cost.

## Reading an answer

Every answer carries the label "AI commentary, not advice; the risk engine decides." It is shown as
plain text only: no links, images, HTML or formatting are ever executed.

- **Figures quoted** lists every number the AI cited. **Verified** means the exact text of that
  number was in what was sent. **Unverified** means it was not: the review is flagged, and you
  should not rely on that number.
- **Wording check**: a rough check looks for sentences that read like a trade instruction ("close
  the trade", "increase your size", "ignore the limit"). If it finds one, a neutral banner appears
  and the text stays. The AI cannot decide anything, and the risk engine has the final say.
- **Some text was cut**: very long notes are cut before sending, with a visible marker in the data.
  The answer may miss details.
- A weekly review of a small sample says so. A handful of trades cannot show a pattern reliably.

## If your key leaks

Assume it can be used by someone else. Do this, in this order:

1. In the Anthropic Console, **revoke (delete) the key** right away.
2. Create a **new key** and run `npm run ai:set-key` again (it replaces the old line in `.env`).
3. Restart the app.
4. Look at the Usage page in the Console for calls you did not make. Your monthly spend limit
   (step 3 above) is what capped the damage.
5. Find out how it leaked (a screenshot, a chat, a commit?) and remove it there too. If it was ever
   committed to git, the old key is already burned: revoking is what matters.

## Choosing the model

The model is the `ANALYST_MODEL` setting in `.env` (the default is `claude-sonnet-5-5`). It must be
listed in `src/domain/analyst/pricing.ts`, otherwise the analyst stays off (a test checks that the
value shown in `.env.example` is priced). To add a model: copy a row, fill in its prices from the
official pricing page, update the "last verified" date and run `npm test`.

Rough comparison (US dollars per million tokens, input / output, checked 2026-10-07): Haiku 4.5
1 / 5 (cheapest), Sonnet 5.5 2 / 10 (the default: good reasoning at a modest price), Opus 5.5
4 / 20, Fable 5.1 10 / 50. Thinking tokens are billed as output tokens, which is why the output
size is capped.

## When it says no (messages and what they mean)

| Message (short)                               | Meaning                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- |
| No API key is set                             | `.env` has no key. Run `npm run ai:set-key`.                        |
| ... does not start with "sk-ant-" / too short | The key you pasted is not an Anthropic key. Run the script again.   |
| ANALYST_MODEL is not in the price table       | Add the model to `pricing.ts`, or use a listed one.                 |
| The privacy switch ... is off                 | Turn it on at `/analyst` (needs a code).                            |
| The daily / monthly limit ... is reached      | A cap stopped it. It resets at UTC midnight / on the 1st.           |
| The usage log could not be read               | The database table could not be read. Nothing is sent until it can. |
| HTTP 401                                      | The key was not accepted (revoked or mistyped).                     |
| HTTP 400 / 429 ... spend limit                | A limit set in the Console (or a rate limit) was reached.           |
| The answer was cut off at the size limit      | The reply hit the size cap, so it was not used (it was billed).     |
| The reply was not in the expected form        | The AI did not follow the JSON shape, so it was not used.           |

## For developers

- `src/domain/analyst/`: pure code (price table, caps, prompt builder, output checks). Tests beside it.
- `src/integrations/anthropic/`: the `AnalystClient` interface, the `fetch` client (no SDK, no
  dependency) and the key/model validation. `tests/helpers/analyst.ts` has the fake client every test
  uses. Tests cannot reach the network (`tests/helpers/no-network.ts`).
- `src/analyst/`: the service (all gates, one request at a time, usage and review written in one
  transaction), the input loaders and the lazy runtime.
- `src/data/analyst.ts` and the tables `ai_settings`, `ai_usage`, `ai_reviews` (migration `0004`,
  triggers make the two logs append-only). Consent and cap changes are logged in `auth_events`.
- Rule 3 holds: nothing in this module calculates a financial figure. Figures are copied from the
  engines and labelled.
- Out of scope here: chart or market-data analysis, TradingView or exchange integrations, tools,
  notifications, deployment, bots, order execution.
