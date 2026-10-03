import { displayMoney } from '@/domain/stats';
import type { Breakdown, EquityCurve, GroupStats, Metric } from '@/domain/stats';
import { formatLocal } from '../_lib/form';

/** Presentation only. All numbers come from the stats engine; nothing is calculated here. */

const money = (v: string) => displayMoney(v);

/**
 * A number that may be unavailable: shows the value, or "n/a" with the reason. In wide tables
 * (`compact`) the reason is only a hover tooltip so rows stay short.
 */
export function MetricValue({
  metric,
  format = (v: string) => v,
  compact = false,
}: {
  metric: Metric;
  format?: (v: string) => string;
  compact?: boolean;
}) {
  if (metric.value !== null) return <>{format(metric.value)}</>;
  return (
    <span title={metric.reason ?? ''}>n/a{compact ? '' : <small> ({metric.reason})</small>}</span>
  );
}

export function MetricsTable({ stats, currency }: { stats: GroupStats; currency: string }) {
  const rows: [string, React.ReactNode][] = [
    ['Closed trades', stats.tradeCount],
    ['Wins / losses / breakevens', `${stats.wins} / ${stats.losses} / ${stats.breakevens}`],
    ['Win rate (%)', <MetricValue key="wr" metric={stats.winRatePercent} />],
    [`Gross P&L, before fees (${currency})`, money(stats.grossPnl)],
    [`Total fees deducted (${currency})`, money(stats.totalFees)],
    [`Net P&L, after fees (${currency})`, money(stats.netPnl)],
    [`Total winners (${currency})`, money(stats.totalWinners)],
    [`Total losers (${currency})`, money(stats.totalLosers)],
    ['Average win', <MetricValue key="aw" metric={stats.averageWin} format={money} />],
    ['Average loss', <MetricValue key="al" metric={stats.averageLoss} format={money} />],
    ['Largest win', <MetricValue key="lw" metric={stats.largestWin} format={money} />],
    ['Largest loss', <MetricValue key="ll" metric={stats.largestLoss} format={money} />],
    ['Average R, before fees', <MetricValue key="ar" metric={stats.averageR} />],
    [
      `Expectancy in R, after fees (over ${stats.flags.netRTradeCount} of ${stats.tradeCount} trades)`,
      <MetricValue key="er" metric={stats.expectancyR} />,
    ],
    [
      'Expectancy in money per trade',
      <MetricValue key="em" metric={stats.expectancyMoney} format={money} />,
    ],
    ['Profit factor', <MetricValue key="pf" metric={stats.profitFactor} />],
    ['Payoff ratio', <MetricValue key="pr" metric={stats.payoffRatio} />],
    ['Longest winning streak', stats.longestWinStreak],
    ['Longest losing streak', stats.longestLossStreak],
    [`Max drawdown, amount (${currency})`, money(stats.maxDrawdown.amount)],
    ['Max drawdown (%)', <MetricValue key="dd" metric={stats.maxDrawdown.percent} />],
  ];
  return (
    <table border={1} cellPadding={6}>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th align="left">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BreakdownTable({
  title,
  groups,
  firstColumn,
}: {
  title: string;
  groups: Breakdown[];
  firstColumn: string;
}) {
  return (
    <>
      <h3>{title}</h3>
      {groups.length === 0 ? (
        <p>No closed trades.</p>
      ) : (
        <table border={1} cellPadding={6}>
          <thead>
            <tr>
              <th>{firstColumn}</th>
              <th>Trades</th>
              <th>Wins</th>
              <th>Losses</th>
              <th>Breakevens</th>
              <th>Win rate (%)</th>
              <th>Net P&L</th>
              <th>Total winners</th>
              <th>Total losers</th>
              <th>Average win</th>
              <th>Average loss</th>
              <th>Profit factor</th>
              <th>Payoff ratio</th>
              <th>Average R</th>
              <th>Expectancy R</th>
              <th>Expectancy money</th>
              <th>Max drawdown (amount)</th>
              <th>Sample</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const s = g.stats;
              return (
                <tr key={g.key}>
                  <td>{g.label}</td>
                  <td>{s.tradeCount}</td>
                  <td>{s.wins}</td>
                  <td>{s.losses}</td>
                  <td>{s.breakevens}</td>
                  <td>
                    <MetricValue compact metric={s.winRatePercent} />
                  </td>
                  <td>{money(s.netPnl)}</td>
                  <td>{money(s.totalWinners)}</td>
                  <td>{money(s.totalLosers)}</td>
                  <td>
                    <MetricValue compact metric={s.averageWin} format={money} />
                  </td>
                  <td>
                    <MetricValue compact metric={s.averageLoss} format={money} />
                  </td>
                  <td>
                    <MetricValue compact metric={s.profitFactor} />
                  </td>
                  <td>
                    <MetricValue compact metric={s.payoffRatio} />
                  </td>
                  <td>
                    <MetricValue compact metric={s.averageR} />
                  </td>
                  <td>
                    <MetricValue compact metric={s.expectancyR} />
                  </td>
                  <td>
                    <MetricValue compact metric={s.expectancyMoney} format={money} />
                  </td>
                  <td>{money(s.maxDrawdown.amount)}</td>
                  <td>
                    {s.sampleSize.reliable ? 'ok (30+)' : `⚠ only ${s.sampleSize.tradeCount}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

export function EquityTable({ curve, currency }: { curve: EquityCurve; currency: string }) {
  return (
    <table border={1} cellPadding={6}>
      <thead>
        <tr>
          <th>After trade</th>
          <th>Closed at (local)</th>
          <th>Net P&L ({currency})</th>
          <th>Equity ({currency})</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>start</td>
          <td />
          <td />
          <td>
            {money(curve.startingEquity)}{' '}
            {curve.startsFromAccountBalance
              ? '(account starting balance)'
              : '(no starting balance in this currency: starts at 0)'}
          </td>
        </tr>
        {curve.points.map((p) => (
          <tr key={p.tradeId}>
            <td>#{p.tradeId}</td>
            <td>{formatLocal(p.closedAt)}</td>
            <td>{money(p.netPnl)}</td>
            <td>{money(p.equity)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
