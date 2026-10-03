import { listAccounts } from '@/data/accounts';
import { guardedPage } from '../_lib/guard';
import { formatLocal } from '../_lib/form';
import { createAccountAction } from './actions';

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) => {
    const { ok, error } = await searchParams;
    const accounts = listAccounts(ctx.db);
    return (
      <main>
        <h1>Accounts</h1>
        {ok && <p role="status">✅ {ok}</p>}
        {error && <p role="alert">❌ {error}</p>}

        <p role="note">
          ℹ️ <strong>Set the base currency to the currency you actually trade in</strong> (for
          example USDT if you trade BTCUSDT, USD if you trade EURUSD). The starting balance and the
          drawdown percentage on the Stats page only work for trades quoted in this currency,
          because currencies are never converted.
        </p>

        <h2>New paper account</h2>
        <form action={createAccountAction}>
          <p>
            <label>
              Name <input name="name" required maxLength={80} />
            </label>
          </p>
          <p>
            <label>
              Base currency (the currency you trade in){' '}
              <input name="baseCurrency" required placeholder="USDT" maxLength={10} />
            </label>
          </p>
          <p>
            <label>
              Starting balance{' '}
              <input name="startingBalance" required inputMode="decimal" placeholder="10000" />
            </label>
          </p>
          <p>Mode: paper (the only mode available).</p>
          <button type="submit">Create account</button>
        </form>

        <h2>Your accounts</h2>
        {accounts.length === 0 ? (
          <p>No accounts yet.</p>
        ) : (
          <table border={1} cellPadding={6}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Mode</th>
                <th>Starting balance</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.id}</td>
                  <td>{a.name}</td>
                  <td>{a.mode}</td>
                  <td>
                    {a.startingBalance} {a.baseCurrency}
                  </td>
                  <td>{formatLocal(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    );
  },
);
