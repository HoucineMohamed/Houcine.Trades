import { DEFAULT_QUERY, defaultDir, type JournalQuery, type SortKey } from '@/domain/trades/table';

/** A /trades link for a query, leaving out everything that is just the default. */
export function journalHref(query: JournalQuery, patch: Partial<JournalQuery> = {}): string {
  const q = { ...query, ...patch };
  const p = new URLSearchParams();
  if (q.status) p.set('status', q.status);
  if (q.direction) p.set('direction', q.direction);
  if (q.symbol) p.set('symbol', q.symbol);
  if (q.setupId !== null) p.set('setup', String(q.setupId));
  if (q.overrideOnly) p.set('override', '1');
  if (q.sort !== DEFAULT_QUERY.sort) p.set('sort', q.sort);
  if (q.dir !== defaultDir(q.sort)) p.set('dir', q.dir);
  if (q.page > 1) p.set('page', String(q.page));
  const s = p.toString();
  return s ? `/trades?${s}` : '/trades';
}

/** The link for a column header: the first click uses the column's natural direction, then flips. */
export function sortHref(query: JournalQuery, key: SortKey): string {
  const sameColumn = query.sort === key;
  const dir = sameColumn ? (query.dir === 'asc' ? 'desc' : 'asc') : defaultDir(key);
  return journalHref(query, { sort: key, dir, page: 1 });
}

export function ariaSort(query: JournalQuery, key: SortKey): 'ascending' | 'descending' | 'none' {
  return query.sort !== key ? 'none' : query.dir === 'asc' ? 'ascending' : 'descending';
}
