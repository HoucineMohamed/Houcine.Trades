import { Dec, isDecimalString } from '../money/decimal';
import { analyzeEquity, computeGroupStats, sortChronologically } from './group';
import { calculateTrade, type TradeCalc } from './trade';
import type { AccountStats, Breakdown, CurrencyStats, SkippedTrade, StatsInput } from './types';

const NO_START_BREAKDOWN = 'breakdown groups have no starting balance, so no percentage is shown';

function breakdown(
  calcs: TradeCalc[],
  keyOf: (c: TradeCalc) => { key: string; label: string },
  lastKey?: string,
  orderOf?: (key: string) => number,
): Breakdown[] {
  const groups = new Map<string, { label: string; calcs: TradeCalc[] }>();
  for (const c of calcs) {
    const { key, label } = keyOf(c);
    const group = groups.get(key) ?? { label, calcs: [] };
    group.calcs.push(c);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => {
      if (lastKey !== undefined && (ka === lastKey) !== (kb === lastKey))
        return ka === lastKey ? 1 : -1;
      if (orderOf) return orderOf(ka) - orderOf(kb);
      return a.label.localeCompare(b.label);
    })
    .map(([key, g]) => ({
      key,
      label: g.label,
      stats: computeGroupStats(g.calcs, null, NO_START_BREAKDOWN),
    }));
}

function currencyStats(
  quoteCurrency: string,
  calcs: TradeCalc[],
  skipped: SkippedTrade[],
  account: StatsInput['account'],
): CurrencyStats {
  const ordered = sortChronologically(calcs);
  const isBase = quoteCurrency === account.baseCurrency;
  const start =
    isBase && isDecimalString(account.startingBalance) ? new Dec(account.startingBalance) : null;
  const noStartReason =
    `the account's starting balance is in ${account.baseCurrency}, not ${quoteCurrency}, and ` +
    'currencies are never converted, so no percentage can be shown';

  const notes: string[] = [];
  if (!isBase) {
    notes.push(
      `The starting balance (${account.startingBalance} ${account.baseCurrency}) is in a different ` +
        `currency than ${quoteCurrency} and is never converted. The equity curve below starts at 0 ` +
        `and shows cumulative net P&L in ${quoteCurrency}. To get drawdown percentages, set the ` +
        'account base currency to the currency you actually trade in.',
    );
  }

  return {
    quoteCurrency,
    isBaseCurrency: isBase,
    overall: computeGroupStats(ordered, start, noStartReason),
    equityCurve: analyzeEquity(ordered, start, noStartReason).curve,
    tradeResults: ordered.map((c) => c.result),
    bySetup: breakdown(
      ordered,
      (c) =>
        c.trade.setupId === null
          ? { key: 'none', label: '(no setup)' }
          : {
              key: String(c.trade.setupId),
              label: c.trade.setupName ?? `Setup ${c.trade.setupId}`,
            },
      'none',
    ),
    bySymbol: breakdown(ordered, (c) => ({ key: c.trade.symbol, label: c.trade.symbol })),
    byDirection: breakdown(
      ordered,
      (c) => ({ key: c.trade.direction, label: c.trade.direction }),
      undefined,
      (key) => (key === 'long' ? 0 : 1),
    ),
    byAssetClass: breakdown(ordered, (c) => ({
      key: c.trade.assetClass,
      label: c.trade.assetClass,
    })),
    skipped,
    notes,
  };
}

/**
 * Statistics for one account. Trades are split by quote currency FIRST and every currency is
 * computed completely separately: amounts in different currencies are never added together.
 * The account's base currency is always present (even with no trades); the other currencies
 * follow alphabetically.
 */
export function computeAccountStats(input: StatsInput): AccountStats {
  const byCurrency = new Map<string, { calcs: TradeCalc[]; skipped: SkippedTrade[] }>();
  const bucket = (currency: string) => {
    const b = byCurrency.get(currency) ?? { calcs: [], skipped: [] };
    byCurrency.set(currency, b);
    return b;
  };
  bucket(input.account.baseCurrency);

  for (const trade of input.trades) {
    const outcome = calculateTrade(trade);
    const target = bucket(trade.quoteCurrency);
    if (outcome.ok) target.calcs.push(outcome.calc);
    else target.skipped.push(outcome.skipped);
  }

  const currencies = [...byCurrency.entries()]
    .sort(([a], [b]) => {
      if ((a === input.account.baseCurrency) !== (b === input.account.baseCurrency)) {
        return a === input.account.baseCurrency ? -1 : 1;
      }
      return a.localeCompare(b);
    })
    .map(([currency, b]) => currencyStats(currency, b.calcs, b.skipped, input.account));

  return {
    accountId: input.account.id,
    accountName: input.account.name,
    baseCurrency: input.account.baseCurrency,
    startingBalance: input.account.startingBalance,
    currencies,
  };
}
