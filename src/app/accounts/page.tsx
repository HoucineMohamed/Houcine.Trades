import { listAccounts } from '@/data/accounts';
import { formatMoney } from '../_lib/format';
import { guardedPage } from '../_lib/guard';
import { Help } from '../_lib/Help';
import { formatLocal } from '../_lib/form';
import { createAccountAction } from './actions';

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) => {
    const { ok, error } = await searchParams;
    const accounts = listAccounts(ctx.db);
    return (
      <main>
        <div className="page-head">
          <h1>Accounts</h1>
          <p className="lead">
            A paper account holds a starting balance and its own risk limits. Nothing here trades
            real money.
          </p>
        </div>
        {ok && (
          <p role="status" className="notice notice-ok">
            {ok}
          </p>
        )}
        {error && (
          <p role="alert" className="notice notice-alert">
            {error}
          </p>
        )}

        <p className="notice notice-note" role="note">
          <strong>Set the base currency to the currency you actually trade in</strong> (for example
          USDT if you trade BTCUSDT, USD if you trade EURUSD). The starting balance and the drawdown
          percentage only work for trades quoted in this currency, because currencies are never
          converted. <Help id="baseCurrency" />
        </p>

        <section aria-labelledby="new-account">
          <div className="section-head">
            <h2 id="new-account">New paper account</h2>
          </div>
          <form action={createAccountAction} className="panel">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="a-name">Name</label>
                <input id="a-name" name="name" required maxLength={80} />
              </div>
              <div className="field">
                <label htmlFor="a-cur">Base currency (the currency you trade in)</label>
                <input id="a-cur" name="baseCurrency" required placeholder="USDT" maxLength={10} />
              </div>
              <div className="field">
                <label htmlFor="a-bal">Starting balance</label>
                <input
                  id="a-bal"
                  name="startingBalance"
                  required
                  inputMode="decimal"
                  placeholder="10000"
                />
              </div>
            </div>
            <p className="small">Mode: paper (the only mode available).</p>
            <button type="submit">Create account</button>
          </form>
        </section>

        <section aria-labelledby="your-accounts">
          <div className="section-head">
            <h2 id="your-accounts">Your accounts</h2>
          </div>
          {accounts.length === 0 ? (
            <p className="small">No accounts yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Name</th>
                    <th>Mode</th>
                    <th className="num">Starting balance</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.id}</td>
                      <td>{a.name}</td>
                      <td>
                        <span className="badge badge-paper">{a.mode}</span>
                      </td>
                      <td className="num">
                        {formatMoney(a.startingBalance)} {a.baseCurrency}
                      </td>
                      <td>{formatLocal(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    );
  },
);
