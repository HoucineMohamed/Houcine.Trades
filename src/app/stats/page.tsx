import { listAccounts } from '@/data/accounts';
import { loadStatsInput } from '@/data/stats';
import { computeAccountStats } from '@/domain/stats';
import { guardedPage } from '../_lib/guard';
import { toId } from '../_lib/form';
import { BreakdownTable, EquityTable, MetricsTable } from './tables';

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<{ account?: string }> }) => {
    const sp = await searchParams;
    const db = ctx.db;
    const accounts = listAccounts(db);
    const selectedId = toId(sp.account) ?? accounts[0]?.id;
    const account = accounts.find((a) => a.id === selectedId);
    const stats = account ? computeAccountStats(loadStatsInput(db, account.id)) : undefined;

    return (
      <main>
        <h1>Stats</h1>
        <p>
          Numbers and flags only, computed from your <strong>closed</strong> trades by tested code.
          They describe the past; they are not advice. Every metric is explained in{' '}
          <code>docs/stats-glossary.md</code>. Amounts in different currencies are never added
          together: each currency has its own section.
        </p>

        {accounts.length === 0 ? (
          <p>No accounts yet. Create one in Accounts, then log and close some trades.</p>
        ) : (
          <form method="get">
            <label>
              Account{' '}
              <select name="account" defaultValue={String(account?.id ?? '')}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.baseCurrency})
                  </option>
                ))}
              </select>
            </label>{' '}
            <button type="submit">Show</button>
          </form>
        )}
        {accounts.length > 0 && !account && <p role="alert">❌ That account does not exist.</p>}

        {stats && (
          <>
            <h2>
              {stats.accountName}: starting balance {stats.startingBalance} {stats.baseCurrency}
            </h2>
            {stats.currencies.map((c) => (
              <section key={c.quoteCurrency}>
                <h2>
                  Trades quoted in {c.quoteCurrency}
                  {c.isBaseCurrency ? ' (account base currency)' : ''}
                </h2>
                {c.notes.map((note) => (
                  <p key={note}>ℹ️ {note}</p>
                ))}
                {c.overall.sampleSize.warning && (
                  <p role="status">⚠️ {c.overall.sampleSize.warning}</p>
                )}
                {c.overall.flags.tradesWithExcludedFees > 0 && (
                  <p role="status">
                    ⚠️ {c.overall.flags.tradesWithExcludedFees} trade(s) have fees in a different
                    currency than the trade. Those fees were NOT converted and are left out of the
                    net figures, so net P&L is slightly too high.
                  </p>
                )}
                {c.skipped.length > 0 && (
                  <div role="status">
                    ⚠️ {c.skipped.length} closed trade(s) could not be used and are NOT counted:
                    <ul>
                      {c.skipped.map((s) => (
                        <li key={s.tradeId}>
                          Trade #{s.tradeId}: {s.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <h3>Overall</h3>
                <MetricsTable stats={c.overall} currency={c.quoteCurrency} />

                <BreakdownTable title="By setup" groups={c.bySetup} firstColumn="Setup" />
                <BreakdownTable title="By symbol" groups={c.bySymbol} firstColumn="Symbol" />
                <BreakdownTable
                  title="By direction"
                  groups={c.byDirection}
                  firstColumn="Direction"
                />
                <BreakdownTable
                  title="By asset class"
                  groups={c.byAssetClass}
                  firstColumn="Asset class"
                />
                <p>
                  <small>
                    In the breakdowns, drawdown is measured from zero (no starting balance), so it
                    has no percentage.
                  </small>
                </p>

                <h3>Equity curve (after each closed trade, in order of closing)</h3>
                <EquityTable curve={c.equityCurve} currency={c.quoteCurrency} />
              </section>
            ))}
          </>
        )}
      </main>
    );
  },
);
