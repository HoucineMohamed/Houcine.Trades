# Risk rules (plain language)

These are the safety rules the **risk engine** enforces. They are code, not advice: the engine
decides whether a trade plan is allowed, works out how big a trade may be, and can halt trading.
The AI (later) may only **propose** plans. **The engine has the final say.**

> The numbers on this page are the **defaults**. You can change them on the **Risk** page, but
> only within hard ceilings that are written into the code (see [Hard ceilings](#hard-ceilings)).

## The three principles

1. **Fail closed.** If anything the engine needs is missing, invalid or unclear, the plan is
   **refused** with a reason. Nothing is ever approved "by default" and nothing is guessed.
2. **Size is always rounded down.** Never up, so the money at risk can never be more than the limit.
3. **Exactly at a limit is allowed; one unit over is refused.** (For the two _halts_ the rule is
   different on purpose: see [What "hit" means for a halt](#what-hit-means-for-a-halt).)

All maths uses exact decimal numbers (no rounding errors). Limits are always compared exactly,
never with the rounded percentages you see on screen.

## What the engine checks on every plan

A plan is: symbol, direction (long or short), entry price, stop-loss, optional target, size, and
the currency the price is quoted in. The engine lists **every** problem it finds, not just the
first one.

| Rule (code)                                                              | What it means                                                                                                        | Why it exists                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stop-loss required** (`NO_STOP_LOSS`)                                  | Every plan needs a stop-loss price greater than 0.                                                                   | A stop-loss is the only thing that caps how much one trade can lose. No stop, no trade.                                                                                                        |
| **Stop on the correct side** (`STOP_WRONG_SIDE`)                         | Long: stop below the entry. Short: stop above the entry. Equal to the entry is refused too.                          | A stop on the wrong side would close the trade at once, or never protect you.                                                                                                                  |
| **Target on the correct side** (`TARGET_WRONG_SIDE`)                     | Long: target above the entry. Short: below.                                                                          | A target on the wrong side makes the reward-to-risk number meaningless.                                                                                                                        |
| **Valid plan** (`INVALID_PLAN`)                                          | Entry price and size must be numbers above 0, direction must be long or short.                                       | The risk cannot be calculated from nonsense.                                                                                                                                                   |
| **Max risk per trade** (`MAX_RISK_PER_TRADE`)                            | Money lost if the stop is hit (`\|entry − stop\| × size`) must not exceed **1 %** of current equity.                 | One losing trade must never cost much. 1 % means you can lose many trades in a row and still be in the game.                                                                                   |
| **Max total open risk** (`MAX_OPEN_RISK`)                                | The risk of all open trades **plus** this plan must not exceed **3 %** of equity.                                    | Several small risks can add up to one big one, especially when markets move together.                                                                                                          |
| **Max open trades** (`MAX_OPEN_TRADES`)                                  | At most **3** trades open at the same time (this plan counts as one more).                                           | Too many open trades means you cannot watch them all. The limit also stops over-trading.                                                                                                       |
| **Currency check** (`CURRENCY_MISMATCH`)                                 | The plan's quote currency must equal the account's base currency.                                                    | Equity exists in one currency and the tool never converts currencies, so risk in another currency cannot be verified. The message says: "risk cannot be verified without currency conversion". |
| **Equity must be known** (`EQUITY_UNAVAILABLE`)                          | Current equity must be calculable and above 0. A closed trade the stats engine could not calculate also blocks this. | Every percentage limit is a percentage of equity. Without a trusted equity there is nothing to measure against.                                                                                |
| **Open risk must be known** (`OPEN_RISK_UNVERIFIABLE`)                   | Every open trade needs a valid entry, initial stop and size, and must be in the account currency.                    | If the risk of an open trade is unknown, the total cannot be trusted.                                                                                                                          |
| **Settings must be valid** (`SETTINGS_INVALID`)                          | Stored settings that are missing, unreadable, or above a hard ceiling make every plan refused.                       | A damaged limit is not a limit.                                                                                                                                                                |
| **Account must exist** (`ACCOUNT_UNKNOWN`)                               | The plan must belong to a real account.                                                                              | Nothing can be verified for an account that does not exist.                                                                                                                                    |
| **Not halted** (`HALTED_DAILY_LOSS`, `HALTED_DRAWDOWN`, `HALTED_MANUAL`) | While a halt is active, every plan is refused.                                                                       | See [Halts](#halts-the-kill-switch).                                                                                                                                                           |

### Warnings (never a refusal)

| Warning                    | Meaning                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LOW_REWARD_TO_RISK`       | The target is closer than **1.5×** the stop distance. Exactly 1.5 is fine.                                  |
| `NO_TARGET`                | No take-profit was given, so the reward-to-risk could not be checked.                                       |
| `EQUITY_MAY_BE_OVERSTATED` | Some closed trades had fees in another currency that were not deducted, so equity may be slightly too high. |

Why only a warning for reward-to-risk? A low ratio is not always wrong (for example when the
win rate is very high), and the engine cannot judge your strategy. It just makes sure you see it.

## Equity (what the percentages are measured against)

**Current equity = account starting balance + net realised profit and loss**, taken from the stats
engine (so after fees).

- **Unrealised profit and loss is NOT counted.** A trade that is open and currently losing does not
  reduce equity until it is closed, because there are no live prices yet. The open-risk rule
  partly covers this gap. **Keep this in mind: your real position can be worse than equity shows.**
- Equity exists **only in the account base currency**. Trades in another currency never change it.
- Fees in another currency are not converted; they are left out and you get the warning above.

## The UTC day

The "day" for the daily loss rule is the **UTC day**: it starts at 00:00 UTC and ends at 00:00 UTC
the next day, whatever your local time zone. (In many time zones this is not midnight for you.)
The Risk page shows the exact moment today started.

### Which closed trades count as "today"

A closed trade counts toward **today's** result if **either** of these falls on today's UTC day:

- the **closed time** you entered for the trade, **or**
- the time the trade was **recorded as closed** in the journal (stamped by the system when you
  pressed "Close", and never changeable afterwards).

Why both? You choose the closed time yourself, so it could be set to yesterday. A loss you enter
today with yesterday's closed time still counts today. (The recorded time is not the "last updated"
time: editing your notes later does not move it.) For trades that were already closed before this
feature existed, the recorded time was approximated by their last update time.

"Equity at the start of today" only includes trades that are in neither group.

## Halts (the kill switch)

While trading is halted, **every new plan is refused**. Closing trades, moving stops and editing
notes always still work, because they only reduce risk.

| Halt                     | Starts when                                                                          | Ends when                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Daily loss**           | Today's net realised loss reaches **3 %** of the equity at the start of the UTC day. | By itself, at the next UTC midnight. You cannot reset it.                     |
| **Drawdown**             | Equity falls **10 %** (or more) from its peak.                                       | Only when **you** reset it, and **not before 24 hours** after the halt began. |
| **Manual (kill switch)** | You press "Halt trading now" on the Risk page and give a reason.                     | When you reset it (immediately possible).                                     |

Why these exist: the daily limit caps what one day can cost. The drawdown halt forces a pause and a review when something is clearly
wrong. The kill switch is for when you decide to stop trading.

### What "hit" means for a halt

For the **halts**, the limit is **reached**, not exceeded: a loss of exactly 3 % (or a drawdown of
exactly 10 %) already halts trading. A safety stop acts at the line, not one step past it.
The other limits (risk per trade, open risk, number of trades) allow exactly the limit.

### Drawdown details

- The drawdown is measured from the **highest equity** reached since your last manual reset (or since
  the beginning). Recovering afterwards **does not** lift the halt: the fall already happened.
- **Resetting needs three things:** the exact word `RESET` typed in capitals, a reason of at least
  10 characters, and **24 hours** since the halt began. The Risk page shows the time remaining. If you
  try earlier, it is refused **and the attempt is logged**.
- A reset makes your **current equity the new baseline**: the drawdown limit is then measured from
  there. Otherwise the halt would trigger again immediately. Each reset
  allows another 10 % fall from the new starting point. The reset is logged with the old peak and
  the new baseline so nothing is hidden.
- The halt time is when the trade that caused it was **recorded**, not the closed time you typed.
- A halt can never be lost by a restart: it is worked out from your trades and the event log, and
  the log is saved in the database and cannot be edited or deleted.

## The position-size calculator

Given your equity, risk %, entry and stop, it tells you the **largest size that stays inside the
limit**:

```
risk budget   = equity x risk % / 100
risk per unit = |entry - stop|  (+ estimated fees per unit)
size          = risk budget / risk per unit, rounded DOWN to your size step
```

Example: equity 10000, risk 1 %, entry 100, stop 95. Budget = 100, distance = 5, so size = **20**.
Money at risk = 20 × 5 = 100, which is exactly 1 %.

- **Size step / minimum size:** exchanges only accept sizes in steps (for example 0.001). The size is
  rounded **down** to a whole number of steps. If the result is below the minimum size (or zero) you
  get a refusal, never a bigger size.
- **Estimated fees:** give the whole round trip (buy and sell) as a percent of the trade value. The
  fees are added to the risk per unit, so the size shrinks a little and the **total** risk including
  fees stays inside the budget.
- It refuses a zero stop distance, a stop on the wrong side, no stop, a risk % above the hard
  ceiling of 2 %, and zero or missing equity.
- The "risk used" percentage is rounded **up** and the reward-to-risk is rounded **down**, so what you
  see never makes things look safer than they are.

## Settings and hard ceilings

### Hard ceilings

These limits are in the code. A setting above them is **rejected**, and a stored value above them
(for example from a damaged database) makes every plan refused.

| Setting                | Default | Hard ceiling                     |
| ---------------------- | ------- | -------------------------------- |
| Max risk per trade     | 1 %     | **2 %**                          |
| Max daily loss         | 3 %     | **5 %**                          |
| Max total open risk    | 3 %     | **6 %** (see note)               |
| Max open trades        | 3       | **6**                            |
| Max drawdown           | 10 %    | **20 %**                         |
| Minimum reward-to-risk | 1.5     | none (warning only); at most 100 |

_Note:_ the first four ceilings (2 %, 5 %, 6 trades, 20 %) are the ones you specified. The 6 % ceiling
on total open risk and the limit of 100 on reward-to-risk were added so that no setting is unlimited;
change them in `src/domain/risk/settings.ts` if you disagree.

### Tightening is immediate, loosening takes 24 hours

- **Tighter** (a smaller limit, or a larger minimum reward-to-risk): applies **at once**.
- **Looser:** saved as a **pending** change that takes effect **24 hours later** (the Risk page shows
  the time). Why: limits are often loosened right after a loss; the cooling-off delay puts a day
  between the loss and the change.
- Asking again for the same looser value keeps the original timer. A different looser value restarts
  it. Asking for a tighter or the current value cancels the pending change.
- Every change is logged. A pending loosening can never hide a halt that already happened.

## The journal and overrides

You may **log** a trade that breaks the rules (for example one you already took on an exchange, or one
you want to study), but only with an **override**:

1. Type the exact word `OVERRIDE` in capitals.
2. Give a **reason** of at least 10 characters.

The trade is then saved together with the refused verdict, your reason and the codes it broke, an
event is logged, and the trade is marked **⚠ OVERRIDE** in the list, permanently. Without an override,
a refused plan is **not saved at all** (only a refusal event is logged).

Every trade also gets a **verdict snapshot** when it is created and again when it is opened, so you
can always see what the engine said at that moment.

### Real orders have NO override

When real order execution is built (a later module), **a refused plan can never become an order.**
There is no override for orders: the code that will place orders must call
`requireApprovedForExecution(verdict)`, which has no override option and throws unless the verdict is
a clean approval. Logging a trade in the journal is not placing an order.

### How statistics can later show override trades (proposal, not built yet)

The verdicts are already stored, so a later change can add a `ruleOverride` yes/no field to each
trade given to the stats engine, and then:

- add a **"By rule compliance"** breakdown ("followed the rules" versus "override") next to the
  breakdowns by setup, symbol, direction and asset class;
- show **"trades logged with an override: N"** on every group;
- optionally let you exclude override trades from the headline numbers.

That would show whether the trades where you broke your own rules did better or worse.

## What the engine does not do

- It does not count **unrealised** profit and loss, because there are no live prices yet.
- It does not convert **currencies** (it refuses instead).
- It does not know about **leverage**, margin, funding or futures contract sizes.
- It cannot stop you from trading **outside** this tool.
- Until login exists (module 4) anyone who can reach the app can use the kill switch, change settings
  or override. Keep it on your own computer.

## Event log

Everything important is written to an append-only log (the database refuses to change or delete
rows): refused plans, halts, resets (and refused reset attempts), settings changes and when a pending
change became effective, and overrides. The Risk page shows the most recent events.
