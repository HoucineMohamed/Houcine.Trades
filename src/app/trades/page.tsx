import Link from 'next/link';
import { listJournal, type JournalRow } from '@/data/journal-view';
import { STATUSES, DIRECTIONS } from '@/domain/trades/types';
import { parseJournalQuery, type SortKey } from '@/domain/trades/table';
import { selectedAccount } from '../_lib/account';
import { formatAmount, formatUtc } from '../_lib/format';
import { guardedPage } from '../_lib/guard';
import { Signed, SignedR } from '../_lib/ui';
import { ariaSort, journalHref, sortHref } from './query';

type SearchParams = Record<string, string | undefined>;

function SortHeader({
  q,
  sortKey,
  children,
  num,
}: {
  q: ReturnType<typeof parseJournalQuery>;
  sortKey: SortKey;
  children: string;
  num?: boolean;
}) {
  return (
    <th className={num ? 'num' : undefined} aria-sort={ariaSort(q, sortKey)}>
      <Link className="sort-link" href={sortHref(q, sortKey)}>
        {children}
        {q.sort === sortKey ? (q.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </Link>
    </th>
  );
}

const when = (r: JournalRow) =>
  r.status === 'closed' ? formatUtc(r.closedAt) : r.openedAt ? formatUtc(r.openedAt) : '';

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<SearchParams> }) => {
    const sp = await searchParams;
    const { selected } = await selectedAccount(ctx);
    if (!selected) {
      return (
        <main>
          <div className="page-head">
            <h1>Journal</h1>
          </div>
          <div className="empty">
            <h2>No account yet</h2>
            <p>
              The journal belongs to an account.{' '}
              <Link href="/accounts">Create a paper account</Link> first, then log a trade.
            </p>
          </div>
        </main>
      );
    }
    const q = parseJournalQuery(sp);
    const view = listJournal(ctx.db, selected.id, q);
    const { page } = view;
    const filtered = q.status || q.direction || q.symbol || q.setupId !== null || q.overrideOnly;

    return (
      <main>
        <div className="page-head">
          <h1>Journal</h1>
          <p className="lead">
            Every trade of <strong>{selected.name}</strong>. Net result and net R come from the
            stats engine, in the currency each trade is quoted in.
          </p>
        </div>
        {sp.ok && (
          <p role="status" className="notice notice-ok">
            {sp.ok}
          </p>
        )}
        {sp.error && (
          <p role="alert" className="notice notice-alert">
            {sp.error}
          </p>
        )}

        <form method="get" className="filters" aria-label="Filter the journal">
          <div>
            <label htmlFor="flt-status">Status</label>
            <select id="flt-status" name="status" defaultValue={q.status ?? ''}>
              <option value="">all</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="flt-direction">Direction</label>
            <select id="flt-direction" name="direction" defaultValue={q.direction ?? ''}>
              <option value="">all</option>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="flt-symbol">Symbol</label>
            <input id="flt-symbol" name="symbol" defaultValue={q.symbol ?? ''} maxLength={30} />
          </div>
          <div>
            <label htmlFor="flt-setup">Setup</label>
            <select id="flt-setup" name="setup" defaultValue={q.setupId ?? ''}>
              <option value="">all</option>
              {view.setups.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="flt-override">
              <input
                id="flt-override"
                type="checkbox"
                name="override"
                value="1"
                defaultChecked={q.overrideOnly}
              />{' '}
              Overrides only
            </label>
          </div>
          {q.sort !== 'created' && <input type="hidden" name="sort" value={q.sort} />}
          <div>
            <button type="submit">Apply</button>
          </div>
          {filtered && (
            <div>
              <Link href="/trades">Clear filters</Link>
            </div>
          )}
        </form>

        <p className="small">
          {page.total} {page.total === 1 ? 'trade' : 'trades'}
          {filtered ? ` match (of ${view.totalAll})` : ''}.{' '}
          <Link href="/trades/new">New trade</Link>
        </p>

        {view.totalAll === 0 ? (
          <div className="empty">
            <h2>The journal is empty</h2>
            <p>
              <Link href="/trades/new">Log a first paper trade</Link>. A stop-loss is required and
              the risk engine checks the plan first.
            </p>
          </div>
        ) : page.total === 0 ? (
          <p>No trade matches these filters.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortHeader q={q} sortKey="created">
                    Trade
                  </SortHeader>
                  <SortHeader q={q} sortKey="symbol">
                    Symbol
                  </SortHeader>
                  <SortHeader q={q} sortKey="status">
                    Status
                  </SortHeader>
                  <th>Setup</th>
                  <th className="num">Entry</th>
                  <th className="num">Exit</th>
                  <th className="num">Size</th>
                  <SortHeader q={q} sortKey="pnl" num>
                    Net result
                  </SortHeader>
                  <SortHeader q={q} sortKey="r" num>
                    Net R
                  </SortHeader>
                  <SortHeader q={q} sortKey={q.status === 'closed' ? 'closed' : 'opened'}>
                    {q.status === 'closed' ? 'Closed (UTC)' : 'Date (UTC)'}
                  </SortHeader>
                </tr>
              </thead>
              <tbody>
                {page.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="row-link" href={`/trades/${r.id}`}>
                        #{r.id}
                      </Link>{' '}
                      {r.overridden && <span className="badge badge-override">override</span>}
                    </td>
                    <td>{r.symbol}</td>
                    <td>{r.direction}</td>
                    <td className={`status-${r.status}`}>{r.status}</td>
                    <td>{r.setupName ?? ''}</td>
                    <td className="num">
                      {formatAmount(r.entryPrice ?? r.plannedEntry)}
                      {r.entryPrice === null && <span className="small"> planned</span>}
                    </td>
                    <td className="num">{r.exitPrice ? formatAmount(r.exitPrice) : ''}</td>
                    <td className="num">{formatAmount(r.size)}</td>
                    <td className="num">
                      {r.netPnl === null ? (
                        r.status === 'closed' ? (
                          <span className="na">not calculated</span>
                        ) : (
                          ''
                        )
                      ) : (
                        <Signed value={r.netPnl} currency={r.quoteCurrency} />
                      )}
                    </td>
                    <td className="num">
                      {r.netR === null ? (
                        r.status === 'closed' ? (
                          <span className="na">n/a</span>
                        ) : (
                          ''
                        )
                      ) : (
                        <SignedR value={r.netR} />
                      )}
                    </td>
                    <td>{when(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {page.pages > 1 && (
          <nav className="pager" aria-label="Pages">
            {page.page > 1 ? (
              <Link href={journalHref(q, { page: page.page - 1 })} rel="prev">
                ← Previous
              </Link>
            ) : (
              <span className="na">← Previous</span>
            )}
            <span>
              Page {page.page} of {page.pages}
            </span>
            {page.page < page.pages ? (
              <Link href={journalHref(q, { page: page.page + 1 })} rel="next">
                Next →
              </Link>
            ) : (
              <span className="na">Next →</span>
            )}
          </nav>
        )}
      </main>
    );
  },
);
