import Link from 'next/link';
import { selectedAccount } from '../../_lib/account';
import { guardedPage } from '../../_lib/guard';
import { runWeeklyAction } from '../actions';

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<{ error?: string }> }) => {
    const sp = await searchParams;
    const { accounts, selected } = await selectedAccount(ctx);
    const today = ctx.now.toISOString().slice(0, 10);
    const weekAgo = new Date(ctx.now.getTime() - 6 * 24 * 3600_000).toISOString().slice(0, 10);
    return (
      <main>
        <div className="page-head">
          <h1>Weekly review</h1>
          <p className="lead">
            The analyst reads the closed trades of one date range, in ONE currency (currencies are
            never mixed). AI commentary, not advice; the risk engine decides.{' '}
            <Link href="/analyst">Settings and usage</Link>
          </p>
        </div>
        {sp.error && (
          <p role="alert" className="notice notice-alert">
            {sp.error}
          </p>
        )}
        {accounts.length === 0 ? (
          <div className="empty">
            <h2>No account yet</h2>
            <p>
              <Link href="/accounts">Create a paper account</Link> first.
            </p>
          </div>
        ) : (
          <form action={runWeeklyAction}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="f-accountId">Account</label>
                <select id="f-accountId" name="accountId" defaultValue={String(selected?.id ?? '')}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.baseCurrency})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-from">From (UTC date)</label>
                <input id="f-from" name="from" type="date" defaultValue={weekAgo} required />
              </div>
              <div className="field">
                <label htmlFor="f-to">To (UTC date, included)</label>
                <input id="f-to" name="to" type="date" defaultValue={today} required />
              </div>
              <div className="field">
                <label htmlFor="f-currency">Quote currency</label>
                <input
                  id="f-currency"
                  name="currency"
                  defaultValue={selected?.baseCurrency ?? ''}
                  maxLength={10}
                  required
                />
                <span className="field-hint">for example USDT. One currency per review.</span>
              </div>
            </div>
            <p className="small">
              Sent: the statistics, the closed trades with your notes and emotions, setup names and
              override flags in the range. Not sent: account names or numbers, keys, passwords.
              Asking can take up to a minute.
            </p>
            <button type="submit">Ask the analyst</button>
          </form>
        )}
      </main>
    );
  },
);
