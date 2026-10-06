import type { ReactNode } from 'react';
import type { Breakdown, GroupStats } from '@/domain/stats';
import { formatMoney } from '../_lib/format';
import { Help } from '../_lib/Help';
import type { HelpKey } from '../_lib/help';
import {
  MetricPercent,
  MetricPlain,
  MetricR,
  MetricSigned,
  Signed,
  NotAvailable,
} from '../_lib/ui';

/** Presentation only. All numbers come from the stats engine; nothing is calculated here. */

export function MetricsTable({ stats, currency }: { stats: GroupStats; currency: string }) {
  const rows: [string, ReactNode, HelpKey?][] = [
    ['Closed trades', stats.tradeCount, 'closedTrades'],
    [
      'Wins / losses / breakevens',
      `${stats.wins} / ${stats.losses} / ${stats.breakevens}`,
      'outcome',
    ],
    ['Win rate', <MetricPercent key="wr" metric={stats.winRatePercent} />, 'winRate'],
    [`Gross result, before fees (${currency})`, <Signed key="g" value={stats.grossPnl} />, 'pnl'],
    [`Total fees deducted (${currency})`, formatMoney(stats.totalFees), 'fees'],
    [`Net result, after fees (${currency})`, <Signed key="n" value={stats.netPnl} />, 'netPnl'],
    [
      `Total winners (${currency})`,
      <Signed key="tw" value={stats.totalWinners} />,
      'winnersLosers',
    ],
    [`Total losers (${currency})`, <Signed key="tl" value={stats.totalLosers} />],
    ['Average win', <MetricSigned key="aw" metric={stats.averageWin} />, 'averages'],
    ['Average loss', <MetricSigned key="al" metric={stats.averageLoss} />],
    ['Largest win', <MetricSigned key="lw" metric={stats.largestWin} />, 'largest'],
    ['Largest loss', <MetricSigned key="ll" metric={stats.largestLoss} />],
    ['Average R, before fees', <MetricR key="ar" metric={stats.averageR} />, 'averageR'],
    [
      `Expectancy in R, after fees (over ${stats.flags.netRTradeCount} of ${stats.tradeCount} trades)`,
      <MetricR key="er" metric={stats.expectancyR} />,
      'expectancyR',
    ],
    [
      'Expectancy in money per trade',
      <MetricSigned key="em" metric={stats.expectancyMoney} />,
      'expectancyMoney',
    ],
    ['Profit factor', <MetricPlain key="pf" metric={stats.profitFactor} />, 'profitFactor'],
    ['Payoff ratio', <MetricPlain key="pr" metric={stats.payoffRatio} />, 'payoff'],
    ['Longest winning streak', stats.longestWinStreak, 'streaks'],
    ['Longest losing streak', stats.longestLossStreak],
    [`Max drawdown, amount (${currency})`, formatMoney(stats.maxDrawdown.amount), 'maxDrawdown'],
    ['Max drawdown', <MetricPercent key="dd" metric={stats.maxDrawdown.percent} />],
  ];
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {rows.map(([label, value, help]) => (
            <tr key={label}>
              <th scope="row">
                {label} {help ? <Help id={help} /> : null}
              </th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    <div className="stack">
      <h3>{title}</h3>
      {groups.length === 0 ? (
        <p className="small">No closed trades.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{firstColumn}</th>
                <th className="num">Trades</th>
                <th className="num">Wins</th>
                <th className="num">Losses</th>
                <th className="num">Win rate</th>
                <th className="num">Net result</th>
                <th className="num">Average win</th>
                <th className="num">Average loss</th>
                <th className="num">Profit factor</th>
                <th className="num">Average R</th>
                <th className="num">Expectancy R</th>
                <th className="num">Max drawdown</th>
                <th>Sample</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const s = g.stats;
                return (
                  <tr key={g.key}>
                    <td>{g.label}</td>
                    <td className="num">{s.tradeCount}</td>
                    <td className="num">{s.wins}</td>
                    <td className="num">{s.losses}</td>
                    <td className="num">
                      <MetricPercent metric={s.winRatePercent} />
                    </td>
                    <td className="num">
                      <Signed value={s.netPnl} />
                    </td>
                    <td className="num">
                      <MetricSigned metric={s.averageWin} />
                    </td>
                    <td className="num">
                      <MetricSigned metric={s.averageLoss} />
                    </td>
                    <td className="num">
                      <MetricPlain metric={s.profitFactor} />
                    </td>
                    <td className="num">
                      <MetricR metric={s.averageR} />
                    </td>
                    <td className="num">
                      <MetricR metric={s.expectancyR} />
                    </td>
                    <td className="num">{formatMoney(s.maxDrawdown.amount)}</td>
                    <td>
                      {s.sampleSize.reliable ? (
                        '30 or more trades'
                      ) : (
                        <NotAvailable reason={`only ${s.sampleSize.tradeCount} trades`} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
