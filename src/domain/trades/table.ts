import { Dec } from '../money/decimal';
import { DIRECTIONS, STATUSES, type Direction, type TradeStatus } from './types';

/**
 * Journal table helpers: reading the URL into a safe query, ordering rows, cutting pages. Pure.
 * Ordering by money uses exact decimal comparison (never SQL, never floats). Ordering changes only
 * the ORDER of rows; no amount is calculated here.
 */

export const SORT_KEYS = [
  'created',
  'date',
  'opened',
  'closed',
  'symbol',
  'status',
  'pnl',
  'r',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export const PAGE_SIZE = 25;

export interface JournalQuery {
  status: TradeStatus | null;
  direction: Direction | null;
  symbol: string | null;
  setupId: number | null;
  overrideOnly: boolean;
  sort: SortKey;
  dir: SortDir;
  page: number;
}

export const DEFAULT_QUERY: JournalQuery = {
  status: null,
  direction: null,
  symbol: null,
  setupId: null,
  overrideOnly: false,
  sort: 'created',
  dir: 'desc',
  page: 1,
};

/** Reads untrusted URL parameters. Anything unknown or malformed falls back to the default. */
export function parseJournalQuery(
  input: Record<string, string | string[] | undefined>,
): JournalQuery {
  // A repeated parameter (?symbol=a&symbol=b) arrives as a list: only the first value is used.
  const raw: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(input)) {
    const first = Array.isArray(value) ? value[0] : value;
    raw[key] = typeof first === 'string' ? first : undefined;
  }
  const status = STATUSES.find((s) => s === raw.status) ?? null;
  const direction = DIRECTIONS.find((d) => d === raw.direction) ?? null;
  const symbol = (raw.symbol ?? '').trim().slice(0, 30);
  const setupId = /^\d{1,9}$/.test(raw.setup ?? '') ? Number(raw.setup) : null;
  const sort = SORT_KEYS.find((k) => k === raw.sort) ?? DEFAULT_QUERY.sort;
  const dir: SortDir = raw.dir === 'asc' || raw.dir === 'desc' ? raw.dir : defaultDir(sort);
  const page = /^\d{1,6}$/.test(raw.page ?? '') ? Math.max(1, Number(raw.page)) : 1;
  return {
    status,
    direction,
    symbol: symbol === '' ? null : symbol,
    setupId,
    overrideOnly: raw.override === '1',
    sort,
    dir,
    page,
  };
}

/** Dates and money start with the largest/newest; names start A to Z. */
export function defaultDir(sort: SortKey): SortDir {
  return sort === 'symbol' || sort === 'status' ? 'asc' : 'desc';
}

export interface SortableRow {
  id: number;
  createdAt: string;
  openedAt: string | null;
  closedAt: string | null;
  symbol: string;
  status: string;
  /** Net P&L and net R from the stats engine, or null when not available. */
  netPnl: string | null;
  netR: string | null;
}

const STATUS_ORDER: Record<string, number> = { planned: 0, open: 1, closed: 2, cancelled: 3 };

type Compare<T> = (a: T, b: T) => number;

const byText =
  <T>(pick: (r: T) => string | null): Compare<T> =>
  (a, b) => {
    const x = pick(a) as string;
    const y = pick(b) as string;
    return x < y ? -1 : x > y ? 1 : 0;
  };

const byDecimal =
  <T>(pick: (r: T) => string | null): Compare<T> =>
  (a, b) =>
    new Dec(pick(a) as string).cmp(pick(b) as string);

/**
 * Orders rows. Rows without a value for the chosen column always come LAST, in either direction.
 * Ties are broken by trade id, newest first, so the order is stable and repeatable.
 */
export function sortJournalRows<T extends SortableRow>(
  rows: readonly T[],
  sort: SortKey,
  dir: SortDir,
): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const specs: Record<SortKey, { value: (r: T) => string | null; compare: Compare<T> }> = {
    created: { value: (r) => r.createdAt, compare: byText((r: T) => r.createdAt) },
    // the date the journal shows: the close time of a closed trade, else the opening time
    date: {
      value: (r) => (r.status === 'closed' ? r.closedAt : r.openedAt),
      compare: byText((r: T) => (r.status === 'closed' ? r.closedAt : r.openedAt)),
    },
    opened: { value: (r) => r.openedAt, compare: byText((r: T) => r.openedAt) },
    closed: { value: (r) => r.closedAt, compare: byText((r: T) => r.closedAt) },
    symbol: {
      value: (r) => r.symbol.toUpperCase(),
      compare: byText((r: T) => r.symbol.toUpperCase()),
    },
    status: {
      value: (r) => String(STATUS_ORDER[r.status] ?? 99),
      compare: (a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99),
    },
    pnl: { value: (r) => r.netPnl, compare: byDecimal((r: T) => r.netPnl) },
    r: { value: (r) => r.netR, compare: byDecimal((r: T) => r.netR) },
  };
  const spec = specs[sort];
  return [...rows].sort((a, b) => {
    const av = spec.value(a);
    const bv = spec.value(b);
    if (av === null && bv === null) return b.id - a.id;
    if (av === null) return 1;
    if (bv === null) return -1;
    const c = spec.compare(a, b);
    return c !== 0 ? sign * c : b.id - a.id;
  });
}

export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
  pageSize: number;
}

/** Cuts one page. A page past the end shows the last page; there is always at least one page. */
export function paginate<T>(items: readonly T[], page: number, pageSize = PAGE_SIZE): Page<T> {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return {
    items: items.slice((current - 1) * pageSize, current * pageSize),
    page: current,
    pages,
    total,
    pageSize,
  };
}
