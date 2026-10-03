import Link from 'next/link';
import { listAccounts } from '@/data/accounts';
import { listSetups } from '@/data/setups';
import { listTrades } from '@/data/trades';
import { ValidationError } from '@/domain/errors';
import { isHttpUrl } from '@/domain/fields';
import type { TradeFilter } from '@/domain/trades/inputs';
import { STATUSES, type Trade } from '@/domain/trades/types';
import { requireDb } from '../_lib/db';
import { formatLocal, orUndefined, toId, utcToLocalInput } from '../_lib/form';
import { cancelTradeAction, closeTradeAction, openTradeAction } from './actions';

interface SearchParams {
  ok?: string;
  error?: string;
  status?: string;
  symbol?: string;
  account?: string;
}

function RowActions({ trade, nowLocal }: { trade: Trade; nowLocal: string }) {
  return (
    <>
      {trade.status !== 'cancelled' && <Link href={`/trades/${trade.id}/edit`}>Edit</Link>}
      {trade.status === 'planned' && (
        <>
          <details>
            <summary>Open it</summary>
            <form action={openTradeAction}>
              <input type="hidden" name="id" value={trade.id} />
              <p>
                <label>
                  Entry price{' '}
                  <input
                    name="entryPrice"
                    required
                    inputMode="decimal"
                    defaultValue={trade.plannedEntry}
                  />
                </label>
              </p>
              <p>
                <label>
                  Opened at{' '}
                  <input name="openedAt" type="datetime-local" required defaultValue={nowLocal} />
                </label>
              </p>
              <button type="submit">Mark as open</button>
            </form>
          </details>
          <form action={cancelTradeAction}>
            <input type="hidden" name="id" value={trade.id} />
            <button type="submit">Cancel trade</button>
          </form>
        </>
      )}
      {trade.status === 'open' && (
        <details>
          <summary>Close it</summary>
          <form action={closeTradeAction}>
            <input type="hidden" name="id" value={trade.id} />
            <p>
              <label>
                Exit price <input name="exitPrice" required inputMode="decimal" />
              </label>
            </p>
            <p>
              <label>
                Closed at{' '}
                <input name="closedAt" type="datetime-local" required defaultValue={nowLocal} />
              </label>
            </p>
            <p>
              <label>
                Fees (optional) <input name="fees" inputMode="decimal" />
              </label>
            </p>
            <button type="submit">Close trade</button>
          </form>
        </details>
      )}
    </>
  );
}

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const db = await requireDb();
  const accounts = listAccounts(db);
  const setupNames = new Map(listSetups(db).map((s) => [s.id, s.name]));
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));

  let trades: Trade[] = [];
  let filterError: string | null = null;
  try {
    trades = listTrades(db, {
      status: orUndefined(sp.status) as TradeFilter['status'],
      symbol: orUndefined(sp.symbol),
      accountId: toId(sp.account),
    });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    filterError = error.message;
  }
  const nowLocal = utcToLocalInput(new Date().toISOString());

  return (
    <main>
      <h1>Trades</h1>
      {sp.ok && <p role="status">✅ {sp.ok}</p>}
      {sp.error && <p role="alert">❌ {sp.error}</p>}
      {filterError && <p role="alert">❌ {filterError}</p>}
      <p>
        <Link href="/trades/new">+ New trade</Link>
      </p>

      <form method="get">
        <label>
          Status{' '}
          <select name="status" defaultValue={sp.status ?? ''}>
            <option value="">all</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Symbol <input name="symbol" defaultValue={sp.symbol ?? ''} />
        </label>{' '}
        <label>
          Account{' '}
          <select name="account" defaultValue={sp.account ?? ''}>
            <option value="">all</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>{' '}
        <button type="submit">Filter</button> <Link href="/trades">Reset</Link>
      </form>

      {trades.length === 0 ? (
        <p>No trades found.</p>
      ) : (
        <table border={1} cellPadding={6} style={{ marginTop: '1rem' }}>
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th>Symbol</th>
              <th>Dir</th>
              <th>Status</th>
              <th>Setup</th>
              <th>Planned entry</th>
              <th>Stop-loss</th>
              <th>Take-profit</th>
              <th>Size</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Fees</th>
              <th>Opened</th>
              <th>Closed</th>
              <th>Notes</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td>{accountNames.get(t.accountId)}</td>
                <td>{t.symbol}</td>
                <td>{t.direction}</td>
                <td>{t.status}</td>
                <td>{t.setupId === null ? '' : setupNames.get(t.setupId)}</td>
                <td>{t.plannedEntry}</td>
                <td>{t.stopLoss}</td>
                <td>{t.takeProfit}</td>
                <td>{t.size}</td>
                <td>{t.entryPrice}</td>
                <td>{t.exitPrice}</td>
                <td>
                  {t.fees} {t.feesCurrency}
                </td>
                <td>{formatLocal(t.openedAt)}</td>
                <td>{formatLocal(t.closedAt)}</td>
                <td>
                  {t.planNotes}
                  {t.reviewNotes && <div>Review: {t.reviewNotes}</div>}
                  {t.emotion && <div>Emotion: {t.emotion}</div>}
                  {t.screenshotPath &&
                    (isHttpUrl(t.screenshotPath) ? (
                      <div>
                        <a href={t.screenshotPath} target="_blank" rel="noopener noreferrer">
                          Screenshot
                        </a>
                      </div>
                    ) : (
                      <div>Screenshot: {t.screenshotPath}</div>
                    ))}
                </td>
                <td>
                  <RowActions trade={t} nowLocal={nowLocal} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>Prices are in each trade&apos;s quote currency. Times are your local time.</p>
    </main>
  );
}
