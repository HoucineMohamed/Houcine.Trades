import Link from 'next/link';
import { loadStatsInput } from '@/data/stats';
import { computeAccountStats, computeRDistribution } from '@/domain/stats';
import { selectedAccount } from '../_lib/account';
import { EquityChart, RHistogram } from '../_lib/charts';
import { formatMoney } from '../_lib/format';
import { guardedPage } from '../_lib/guard';
import { Help } from '../_lib/Help';
import { MetricPercent, MetricR, MetricSigned, MetricTile, Signed } from '../_lib/ui';
import { BreakdownTable, MetricsTable } from './tables';

export default guardedPage(async (ctx) => {
  const { selected } = await selectedAccount(ctx);
  if (!selected) {
    return (
      <main>
        <div className="page-head">
          <h1>Stats</h1>
        </div>
        <div className="empty">
          <h2>No account yet</h2>
          <p>
            <Link href="/accounts">Create a paper account</Link>, then log and close some trades.
          </p>
        </div>
      </main>
    );
  }
  const stats = computeAccountStats(loadStatsInput(ctx.db, selected.id));

  return (
    <main>
      <div className="page-head">
        <h1>Stats</h1>
        <p className="lead">
          Numbers and flags from the <strong>closed</strong> trades of {stats.accountName}, computed
          by tested code. They describe the past; they are not advice. Amounts in different
          currencies are never added together: each currency has its own section. Starting balance{' '}
          {formatMoney(stats.startingBalance)} {stats.baseCurrency}.
        </p>
      </div>

      {stats.currencies.map((c) => {
        const o = c.overall;
        const distribution = computeRDistribution(c.tradeResults);
        return (
          <section key={c.quoteCurrency} aria-labelledby={`cur-${c.quoteCurrency}`}>
            <div className="section-head currency-heading">
              <h2 id={`cur-${c.quoteCurrency}`}>Trades quoted in {c.quoteCurrency}</h2>
              {c.isBaseCurrency && <span className="tag">account base currency</span>}
            </div>

            {c.notes.map((note) => (
              <p key={note} className="notice notice-note">
                {note}
              </p>
            ))}
            {o.sampleSize.warning && (
              <div className="notice notice-note" role="status">
                <strong>Small sample.</strong> {o.sampleSize.warning} <Help id="sampleSize" />
              </div>
            )}
            {o.flags.tradesWithExcludedFees > 0 && (
              <p className="notice notice-note" role="status">
                <strong>Fees in another currency.</strong> {o.flags.tradesWithExcludedFees} trade(s)
                have fees in a different currency than the trade. Those fees were not converted and
                are left out of the net figures, so the net result of these trades is shown before
                those fees.
              </p>
            )}
            {c.skipped.length > 0 && (
              <div className="notice notice-note" role="status">
                <strong>Trades not counted.</strong> {c.skipped.length} closed trade(s) could not be
                used:
                <ul>
                  {c.skipped.map((s) => (
                    <li key={s.tradeId}>
                      <Link href={`/trades/${s.tradeId}`}>Trade #{s.tradeId}</Link>: {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="panel">
              <div className="grid grid-tight">
                <MetricTile label="Net result" help="netPnl" small>
                  <Signed value={o.netPnl} currency={c.quoteCurrency} />
                </MetricTile>
                <MetricTile label="Closed trades" help="closedTrades" small>
                  {o.tradeCount}
                </MetricTile>
                <MetricTile label="Win rate" help="winRate" small>
                  <MetricPercent metric={o.winRatePercent} />
                </MetricTile>
                <MetricTile label="Expectancy in R" help="expectancyR" small>
                  <MetricR metric={o.expectancyR} />
                </MetricTile>
                <MetricTile label="Expectancy per trade" help="expectancyMoney" small>
                  <MetricSigned metric={o.expectancyMoney} currency={c.quoteCurrency} />
                </MetricTile>
                <MetricTile label="Max drawdown" help="maxDrawdown" small>
                  {formatMoney(o.maxDrawdown.amount)} {c.quoteCurrency}
                  <div className="metric-sub">
                    <MetricPercent metric={o.maxDrawdown.percent} />
                  </div>
                </MetricTile>
              </div>
            </div>

            <div className="grid grid-2">
              <div className="panel">
                <div className="panel-title">
                  <h3>Equity and the fall from the peak</h3>
                  <Help id="equityCurve" />
                </div>
                <EquityChart
                  curve={c.equityCurve}
                  currency={c.quoteCurrency}
                  id={`eq-${c.quoteCurrency}`}
                />
                {!c.isBaseCurrency && (
                  <div className="small">
                    This currency has no starting balance, so its curve starts at 0.{' '}
                    <Help id="baseCurrency" />
                  </div>
                )}
              </div>
              <div className="panel">
                <div className="panel-title">
                  <h3>How the trades spread over R</h3>
                  <Help id="rMultiple" />
                </div>
                <RHistogram distribution={distribution} id={`r-${c.quoteCurrency}`} />
              </div>
            </div>

            <h3>All metrics</h3>
            <MetricsTable stats={o} currency={c.quoteCurrency} />

            <div className="section-head">
              <h3>Breakdowns</h3>
              <Help id="breakdowns" />
            </div>
            <BreakdownTable title="By setup" groups={c.bySetup} firstColumn="Setup" />
            <BreakdownTable title="By symbol" groups={c.bySymbol} firstColumn="Symbol" />
            <BreakdownTable title="By direction" groups={c.byDirection} firstColumn="Direction" />
            <BreakdownTable
              title="By asset class"
              groups={c.byAssetClass}
              firstColumn="Asset class"
            />
            <p className="small">
              In the breakdowns, drawdown is measured from zero (no starting balance), so it has no
              percentage.
            </p>
          </section>
        );
      })}
    </main>
  );
});
