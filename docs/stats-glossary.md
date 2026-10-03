# Stats glossary (plain language)

This page explains every number on the **Stats** page. All of them are calculated by tested code
in `src/domain/stats/` from your **closed** trades. The AI never does this math.

> **Read this first.** These numbers describe what already happened. They do not predict what
> will happen, and they are not advice. With few trades they can mislead you badly (see
> [Why 30 trades?](#why-30-trades)).

## Limits and assumptions (important)

1. **Spot-style profit and loss.** Profit is simply the price difference times the size. There is
   **no leverage, no contract multiplier, and no funding or overnight fees** in the calculation.
   If you trade futures, CFDs or margin products where one "point" is worth more than one unit
   of currency, the numbers here are **not correct for those trades** until a later module adds
   them.
2. **Currencies are never mixed or converted.** Every amount belongs to the currency the trade is
   quoted in (for example USDT for `BTCUSDT`). The page shows one section per currency and never
   adds two currencies together. See [Account base currency](#account-base-currency).
3. **Fees in another currency are not guessed.** If a trade's fees are in a different currency
   than the trade (for example fees paid in BNB on a USDT trade), the fees are **left out** of the
   net numbers and the trade is **flagged**. Net P&L is then slightly too high. Fees of exactly 0
   are never flagged, whatever their currency.
4. **Only closed trades count.** Planned, open and cancelled trades are ignored.
5. **Trades that cannot be calculated** (for example missing or invalid data) are **not counted**.
   They are listed on the page with the reason, so nothing disappears silently.
6. **Older trades and the initial stop.** The "initial stop-loss" was added in module 2. For trades
   that already existed, it was copied from the stop-loss they had at that time. If you had moved
   that stop before, the original value is lost and R for those trades is only as good as that
   copy.

## Words used consistently

| Word                         | Always means                                                       |
| ---------------------------- | ------------------------------------------------------------------ |
| **before fees** (or "gross") | the price difference times the size, with no fees taken off        |
| **after fees** (or "net")    | the same, minus the fees that are in the trade's own currency      |
| **total winners**            | the sum of the net result of all winning trades                    |
| **total losers**             | the sum of the net result of all losing trades (a negative number) |

"Gross" is only ever used for **before fees** (gross P&L, gross R). The totals of winning and
losing trades are called **total winners** and **total losers** so the word "gross" never has two
meanings. (Many trading books call these "gross profit" and "gross loss"; they are measured **after
fees** here.)

Losses are shown as **negative numbers** everywhere.

## Per-trade numbers

### Gross P&L (profit and loss before fees)

- **Long** (you bought first): `(exit price - entry price) x size`
- **Short** (you sold first): `(entry price - exit price) x size`

Example: long, entry 100, exit 110, size 2 gives `(110 - 100) x 2 = 20`.

### Fees

The fees you recorded for the trade, if they are in the trade's own currency. Otherwise they are
left out and the trade is flagged (see the limits above).

### Net P&L (profit and loss after fees)

`gross P&L - fees`. Example: gross 20, fees 1 gives net 19.

### Win, loss, breakeven

Decided by **net** P&L: above 0 is a **win**, below 0 is a **loss**, exactly 0 is **breakeven**.
A trade that made money before fees but lost it after fees counts as a **loss**.

### Initial stop-loss and the current stop-loss

The **current** stop-loss can be moved while a trade is open. The **initial** stop-loss is the stop
the trade **started with**: it is saved the moment the trade is opened and can never be changed
afterwards (the database itself refuses it). R always uses the initial stop, otherwise moving a
stop closer would make a loss look smaller than the risk you really took.

### Initial risk

`|entry price - initial stop| x size`, in the trade's currency. It is the amount you were prepared
to lose when you entered. Example: entry 100, initial stop 95, size 2 gives `5 x 2 = 10`.

### R-multiple (R)

Profit or loss measured in units of the initial risk: `P&L / initial risk`.

- **R before fees** = gross P&L / initial risk
- **R after fees (net R)** = net P&L / initial risk. Not available when the trade's fees are in a
  different currency.

Example: gross 20, net 19, risk 10 gives R before fees `2.0` and net R `1.9`. A trade that lost
exactly its initial risk is `-1R`.

R lets you compare trades of different sizes. It does **not** exist for a trade with no initial
stop, or with a stop equal to the entry (zero risk). Those trades still count everywhere else.

## Metrics for a group of trades

The same metrics are shown for the whole currency ("Overall") and for each breakdown group.

### Closed trades, wins, losses, breakevens

How many trades, and how many fell in each outcome. Wins + losses + breakevens always equals the
number of trades.

### Win rate (%)

`wins / closed trades x 100`. Example: 4 wins out of 7 trades is 57.14%. Breakevens count as
trades but not as wins.
_Does not tell you_ how big the wins and losses were. A 70% win rate can still lose money if the
losses are much bigger than the wins.

### Gross P&L (before fees), total fees, net P&L (after fees)

The sums over all trades. `gross P&L - total fees = net P&L` always holds. "Total fees" counts only
the fees that were actually taken off (not the flagged ones in another currency).

### Total winners and total losers

Total winners = sum of the net results of the winning trades. Total losers = the same for the
losing trades (negative). Total winners + total losers = net P&L (breakevens add 0).

### Average win and average loss

`total winners / number of wins` and `total losers / number of losses` (the loss is negative).
Not available (`n/a`) if there are no wins, or no losses.

### Largest win and largest loss

The single best and single worst trade by net result. A very large one can dominate everything
else, so look at it next to the average.

### Average R (before fees)

The average of R before fees over the trades that have an R. It is shown together with how many
trades that is in the flags.

### Expectancy in R (after fees)

The average **net** R per trade: add up the net R of every trade that has one, divide by how many
there are. The label shows the count, for example "over 7 of 8 trades" when one trade has no net
R. It answers: "on average, how many units of risk did one trade earn after costs?"

(This equals the textbook formula `win rate x average win R - loss rate x average loss R`; it is
calculated as a plain average so the two can never disagree.)

### Expectancy in money per trade

`net P&L / number of trades`: the average net result of one trade in the trade currency.

Money expectancy and R expectancy can point in different directions. R treats a trade that risked
a little the same as one that risked a lot; money does not. If your bigger-risk trades are the
losers, money can look worse than R.

### Profit factor

`total winners / |total losers|`. Example: 24.9901 / 18.5 = 1.3508. Above 1 means the winners added
up to more than the losers; below 1 means the opposite.

`n/a` when there are no losing trades (the division is not possible). With losses but no wins it
is exactly 0.
_Does not tell you_ how reliable the number is. See the sample-size warning.

### Payoff ratio

`average win / |average loss|`: how big a typical win is compared with a typical loss. `n/a` if
there are no wins or no losses. A payoff ratio below 1 only works if the win rate is high enough
to make up for it.

### Longest winning streak and longest losing streak

The longest run of consecutive wins (or losses) in the order the trades were closed. A breakeven
trade **ends** both kinds of streak. Trades closed at the same moment are ordered by trade number.

### Equity curve

Your account balance after each closed trade, in order of closing: the starting balance, plus the
running total of net P&L. It starts at the **account starting balance** only for the account's base
currency; otherwise it starts at 0 (see below).

### Max drawdown (amount and %)

A **drawdown** is a fall from the highest point (the "peak") the equity curve has reached so far.
The **maximum drawdown** is the deepest such fall.

- When there is a starting balance, the deepest fall is chosen **by percent** (fall / peak x 100),
  and the amount shown is the amount of that **same** fall. The curve begins at the starting
  balance, so losing on your very first trade already counts.
- Example: balance 1000, then +500, -100, -400: the peak is 1500; falls are 100 (6.67%) and 500
  (33.33%). Max drawdown = **500 (33.33%)**.
- If another, later fall is bigger in money but smaller in percent, the percent one wins, because
  it matters more for how much of your account is at risk.
- If the equity never fell, the result is `0` and `0.00%`.
- Without a starting balance (other currencies, and all breakdown groups) the curve starts at 0,
  the amount is still shown, and the percent is `n/a`.

## Account base currency

The account's starting balance exists in **one** currency, the account's base currency. The tool
never converts currencies. So:

- Trades quoted in the **base currency** get the full picture: an equity curve that starts at your
  balance, and a drawdown percentage.
- Trades quoted in **any other currency** get their own section, but the equity curve starts at 0
  and the drawdown percentage is `n/a`.

**Set the account base currency to the currency you actually trade in.** Trade `BTCUSDT`
(quoted in USDT)? Create the account in USDT. Trade `EURUSD` (quoted in USD)? Create it in USD.
If you set the base currency to USD but trade `BTCUSDT`, you get no drawdown percentage at all,
because USD and USDT are different currencies for this tool.

## Breakdowns

Within each currency the page also shows the same metrics split **by setup** (your strategy tags,
plus "(no setup)"), **by symbol**, **by direction** (long and short) and **by asset class**. Each
group is small, so the sample-size warning almost always applies to them. The drawdown in a
breakdown is measured from 0 (no starting balance) and has no percentage.

## Why 30 trades?

Every group shows a warning when it has **fewer than 30 closed trades**. Why:

- Results from a few trades are dominated by luck. Flip a fair coin 10 times and 7 heads is
  completely normal; nobody would conclude the coin is unfair. Ten trades are the same.
- Rough size of the problem: with about 30 trades, a measured win rate is only accurate to about
  **plus or minus 18 percentage points**. A measured 55% could easily be a true 40% or a true 70%.
  With 100 trades it is about plus or minus 10 points.
- Averages and profit factors are even shakier: one lucky trade can change them a lot.

30 is a common rule of thumb for "the numbers start to mean something", not a guarantee. Even at 30
trades the uncertainty is large, and the market can change after you measured. Treat everything on
the page as a record of what happened, not a promise.

## Rounding and precision

The calculations use exact decimal arithmetic (no floating-point numbers). Rounding happens once,
at the very end, always **half-even** ("banker's rounding"; exact halves go to the even digit).

| What                                                          | Shown as               |
| ------------------------------------------------------------- | ---------------------- |
| Money sums and products (P&L, fees, totals, largest win/loss) | exact, never rounded   |
| Money averages and expectancy per trade                       | 8 decimals             |
| R values, profit factor, payoff ratio                         | 4 decimals             |
| Percentages (win rate, drawdown %)                            | in percent, 2 decimals |

The page shows money with at most 8 decimals and trailing zeros removed (so a profit smaller than
0.000000005 can display as 0). The engine's values are not affected by that display rounding.

## When a number is "n/a"

`n/a` is never a crash and never a zero in disguise. It always comes with a reason, for example
"no closed trades", "no losing trades", "no winning trades", "no initial stop-loss recorded for
this trade", "fees are in a different currency than the trade", or "the account's starting balance
is in a different currency".

## A small worked example

Account: starting balance 1000 USDT. Two closed trades:

| Trade | Direction | Entry | Exit | Size | Initial stop | Fees   | Gross P&L | Net P&L | Initial risk | R before fees | Net R |
| ----- | --------- | ----- | ---- | ---- | ------------ | ------ | --------- | ------- | ------------ | ------------- | ----- |
| A     | long      | 100   | 110  | 2    | 95           | 1 USDT | 20        | 19      | 10           | 2.0           | 1.9   |
| B     | short     | 200   | 210  | 1    | 205          | 0.5    | -10       | -10.5   | 5            | -2.0          | -2.1  |

- Wins 1, losses 1, win rate 50.00%
- Net P&L = 19 - 10.5 = **8.5**; total winners 19; total losers -10.5
- Profit factor = 19 / 10.5 = 1.8095; payoff ratio = 19 / 10.5 = 1.8095
- Expectancy in money = 8.5 / 2 = 4.25; average R = (2.0 - 2.0) / 2 = 0.0000;
  expectancy in R = (1.9 - 2.1) / 2 = -0.1000 (note the different signs: see "Expectancy in money")
- Equity: 1000, then 1019, then 1008.5. Max drawdown: peak 1019, fall 10.5 = 1.03%
- Sample size: 2 trades, so the warning applies

## For developers: field names

| On the page                  | Field in `src/domain/stats`    |
| ---------------------------- | ------------------------------ |
| Gross P&L, before fees       | `grossPnl`                     |
| Total fees deducted          | `totalFees`                    |
| Net P&L, after fees          | `netPnl`                       |
| Total winners / total losers | `totalWinners` / `totalLosers` |
| Average R, before fees       | `averageR`                     |
| Expectancy in R, after fees  | `expectancyR`                  |
| Expectancy in money          | `expectancyMoney`              |
