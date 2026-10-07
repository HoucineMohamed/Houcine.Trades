import Link from 'next/link';
import { loadDashboard } from '@/data/dashboard';
import { RISK_DEFAULTS } from '@/domain/risk';
import { formatAmount, formatMoney, formatUtc } from './_lib/format';
import { selectedAccount } from './_lib/account';
import { EquityChart } from './_lib/charts';
import { guardedPage } from './_lib/guard';
import { Help } from './_lib/Help';
import {
  CountMeter,
  MetricPercent,
  MetricSigned,
  MetricTile,
  Signed,
  SignedR,
  TradeLink,
  UsageMeter,
} from './_lib/ui';

function GettingStarted({ hasAccount, hasTrades }: { hasAccount: boolean; hasTrades: boolean }) {
  return (
    <section className="empty" aria-labelledby="start-title">
      <h2 id="start-title">{hasAccount ? 'Your account is ready' : 'Welcome to Houcine.Trades'}</h2>
      <p>
        This is a private paper-trading journal: nothing here places a real order. Three steps to
        get started:
      </p>
      <ol className="steps">
        <li className={hasAccount ? 'done' : undefined}>
          <Link href="/accounts">Create a paper account</Link> (a name, the currency you trade in,
          and a starting balance).
        </li>
        <li>
          <Link href="/risk">Review the risk limits</Link>. The default values are{' '}
          {RISK_DEFAULTS.maxRiskPerTradePercent} % risk per trade,{' '}
          {RISK_DEFAULTS.maxDailyLossPercent} % daily loss, {RISK_DEFAULTS.maxOpenRiskPercent} %
          open risk, {RISK_DEFAULTS.maxOpenTrades} open trades and a{' '}
          {RISK_DEFAULTS.maxDrawdownPercent} % drawdown limit; tightening a limit applies at once.
        </li>
        <li className={hasTrades ? 'done' : undefined}>
          <Link href="/trades/new">Log a first paper trade</Link>. A stop-loss is required, and the
          risk engine checks the plan before it is saved.
        </li>
      </ol>
    </section>
  );
}

export default guardedPage(async (ctx) => {
  const { selected } = await selectedAccount(ctx);
  if (!selected) {
    return (
      <main>
        <div className="page-head">
          <h1>Dashboard</h1>
        </div>
        <GettingStarted hasAccount={false} hasTrades={false} />
      </main>
    );
  }
  const d = loadDashboard(ctx.db, selected.id, ctx.now);
  const base = d.account.baseCurrency;
  const risk = d.risk;

  return (
    <main>
      <div className="page-head">
        <h1>Dashboard</h1>
        <p className="lead">
          Account <strong>{d.account.name}</strong> ({d.account.mode.toUpperCase()}), base currency{' '}
          <strong>{base}</strong>. Amounts of different currencies are never added together; each
          currency has its own section below.
        </p>
      </div>

      {d.counts.total === 0 && <GettingStarted hasAccount hasTrades={false} />}

      {risk.halts.length > 0 && (
        <section className="halt-box" role="alert" aria-label="Trading halt">
          <p>
            <strong>Trading is halted.</strong> Every new plan is refused until the halt ends.
          </p>
          {risk.halts.map((h) => (
            <p key={h.kind}>{h.message}</p>
          ))}
          <p>
            <Link href="/risk">Open the Risk page</Link>
          </p>
        </section>
      )}

      <section aria-labelledby="today-title">
        <div className="section-head">
          <h2 id="today-title">Equity and today</h2>
        </div>
        <div className="grid">
          <div className="panel">
            <MetricTile
              label={`Equity (${base})`}
              help="equity"
              sub={
                risk.equity === null
                  ? risk.equityProblem
                  : 'Starting balance plus net realised results. Open trades are not counted.'
              }
            >
              {risk.equity === null ? (
                <span className="na">cannot be verified</span>
              ) : (
                formatMoney(risk.equity)
              )}
            </MetricTile>
          </div>
          <div className="panel">
            <MetricTile
              label={`Today's result (${base}, UTC day)`}
              help="utcDay"
              sub={`Day started ${formatUtc(risk.dayStart)}`}
            >
              {risk.equity === null ? (
                <span className="na">cannot be verified</span>
              ) : (
                <Signed value={risk.todayNetPnl} />
              )}
            </MetricTile>
          </div>
          <div className="panel">
            <MetricTile
              label="Open trades"
              sub={`${d.counts.planned} planned, ${d.counts.closed} closed, ${d.counts.total} in total`}
            >
              {d.counts.open}
            </MetricTile>
          </div>
        </div>
      </section>

      <section aria-labelledby="limits-title">
        <div className="section-head">
          <h2 id="limits-title">Risk limits in use</h2>
          <Link href="/risk">Settings and halts</Link>
        </div>
        <div className="panel">
          <div className="meter-grid">
            <UsageMeter
              name="Daily loss"
              line={d.usage.dailyLoss}
              currency={base}
              help="halts"
              measuredAgainst="the equity at the start of the UTC day"
            />
            <UsageMeter
              name="Open risk"
              line={d.usage.openRisk}
              currency={base}
              help="ruleOpenRisk"
              measuredAgainst="current equity"
            />
            <CountMeter name="Open trades" usage={d.usage.openTrades} help="ruleOpenTrades" />
            <UsageMeter
              name="Drawdown"
              line={d.usage.drawdown}
              currency={base}
              help="drawdownDetails"
              measuredAgainst="the highest equity since the last baseline"
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="open-title">
        <div className="section-head">
          <h2 id="open-title">Open trades</h2>
          <Link href="/trades?status=open">See all</Link>
        </div>
        {d.openTrades.length === 0 ? (
          <p className="small">No trade is open.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Trade</th>
                  <th>Symbol</th>
                  <th>Direction</th>
                  <th className="num">Entry</th>
                  <th className="num">Initial stop</th>
                  <th className="num">Size</th>
                  <th className="num">Risk at the stop</th>
                  <th>Opened (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {d.openTrades.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <TradeLink id={t.id} />
                    </td>
                    <td>{t.symbol}</td>
                    <td>{t.direction}</td>
                    <td className="num">{t.entryPrice ? formatAmount(t.entryPrice) : ''}</td>
                    <td className="num">
                      {t.initialStopLoss ? formatAmount(t.initialStopLoss) : ''}
                    </td>
                    <td className="num">{formatAmount(t.size)}</td>
                    <td className="num">
                      {t.risk.amount === null ? (
                        <span className="na" title={t.risk.problem ?? undefined}>
                          cannot be verified
                        </span>
                      ) : (
                        <>
                          {formatMoney(t.risk.amount)} {base}
                        </>
                      )}
                    </td>
                    <td>{formatUtc(t.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="currency-title">
        <div className="section-head">
          <h2 id="currency-title">Results by currency</h2>
          <Link href="/stats">All statistics</Link>
        </div>
        {d.stats.currencies.length === 0 && (
          <p className="small">No result can be shown yet: there are no closed trades.</p>
        )}
        <div className="grid grid-2">
          {d.stats.currencies.map((c) => (
            <div className="panel" key={c.quoteCurrency}>
              <div className="panel-title currency-heading">
                <h3>{c.quoteCurrency}</h3>
                {c.isBaseCurrency && <span className="tag">base currency</span>}
              </div>
              <div className="grid grid-tight">
                <MetricTile label="Net result" help="netPnl" small>
                  <MetricSigned
                    metric={{ value: c.overall.netPnl, reason: null }}
                    currency={c.quoteCurrency}
                  />
                </MetricTile>
                <MetricTile label="Closed trades" help="closedTrades" small>
                  {c.overall.tradeCount}
                </MetricTile>
                <MetricTile label="Win rate" help="winRate" small>
                  <MetricPercent metric={c.overall.winRatePercent} />
                </MetricTile>
              </div>
              <EquityChart
                curve={c.equityCurve}
                currency={c.quoteCurrency}
                compact
                id={`dash-eq-${c.quoteCurrency}`}
              />
              {c.overall.sampleSize.warning && (
                <p className="small">{c.overall.sampleSize.warning}</p>
              )}
              {!c.isBaseCurrency && (
                <div className="small">
                  Equity exists only in the base currency ({base}), so there is no equity or
                  drawdown percentage for {c.quoteCurrency}. <Help id="baseCurrency" />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="recent-title">
        <div className="section-head">
          <h2 id="recent-title">Last closed trades</h2>
          <Link href="/trades?status=closed&sort=closed">Journal</Link>
        </div>
        {d.recentClosed.length === 0 ? (
          <p className="small">No trade has been closed yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Trade</th>
                  <th>Closed (UTC)</th>
                  <th>Symbol</th>
                  <th>Direction</th>
                  <th className="num">Net result</th>
                  <th className="num">Net R</th>
                </tr>
              </thead>
              <tbody>
                {d.recentClosed.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <TradeLink id={t.id} />
                    </td>
                    <td>{formatUtc(t.closedAt)}</td>
                    <td>{t.symbol}</td>
                    <td>{t.direction}</td>
                    <td className="num">
                      {t.netPnl === null ? (
                        <span className="na" title={t.skippedReason ?? undefined}>
                          not calculated{t.skippedReason ? ` (${t.skippedReason})` : ''}
                        </span>
                      ) : (
                        <Signed value={t.netPnl} currency={t.quoteCurrency} />
                      )}
                    </td>
                    <td className="num">
                      {t.netR === null ? (
                        <span className="na">n/a</span>
                      ) : (
                        <SignedR value={t.netR} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
});
