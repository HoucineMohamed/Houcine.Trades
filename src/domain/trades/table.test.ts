import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY,
  PAGE_SIZE,
  paginate,
  parseJournalQuery,
  sortJournalRows,
  type SortableRow,
} from './table';

const row = (id: number, over: Partial<SortableRow> = {}): SortableRow => ({
  id,
  createdAt: `2026-01-${String(id).padStart(2, '0')}T00:00:00.000Z`,
  openedAt: null,
  closedAt: null,
  symbol: 'BTCUSDT',
  status: 'planned',
  netPnl: null,
  netR: null,
  ...over,
});
const ids = (rows: SortableRow[]) => rows.map((r) => r.id);

describe('parseJournalQuery', () => {
  it('empty input gives the defaults', () => {
    expect(parseJournalQuery({})).toEqual(DEFAULT_QUERY);
  });
  it('reads valid values', () => {
    expect(
      parseJournalQuery({
        status: 'closed',
        direction: 'short',
        symbol: ' ethusdt ',
        setup: '12',
        override: '1',
        sort: 'pnl',
        dir: 'asc',
        page: '3',
      }),
    ).toEqual({
      status: 'closed',
      direction: 'short',
      symbol: 'ethusdt',
      setupId: 12,
      overrideOnly: true,
      sort: 'pnl',
      dir: 'asc',
      page: 3,
    });
  });
  it('anything unknown or malformed falls back (never throws, never injects)', () => {
    const q = parseJournalQuery({
      status: 'DROP TABLE',
      direction: 'sideways',
      setup: '1; DELETE',
      override: 'yes',
      sort: 'password',
      dir: 'sideways',
      page: '-5',
    });
    expect(q).toEqual(DEFAULT_QUERY);
    expect(parseJournalQuery({ page: '0' }).page).toBe(1);
    expect(parseJournalQuery({ page: '99999999999' }).page).toBe(1);
  });
  it('limits the symbol length', () => {
    expect(parseJournalQuery({ symbol: 'x'.repeat(200) }).symbol).toHaveLength(30);
    expect(parseJournalQuery({ symbol: '   ' }).symbol).toBeNull();
  });
  it('picks a sensible default direction per column', () => {
    expect(parseJournalQuery({ sort: 'symbol' }).dir).toBe('asc');
    expect(parseJournalQuery({ sort: 'pnl' }).dir).toBe('desc');
    expect(parseJournalQuery({ sort: 'symbol', dir: 'desc' }).dir).toBe('desc');
  });
});

describe('sortJournalRows', () => {
  it('by created, newest first by default, and oldest first ascending', () => {
    const rows = [row(1), row(3), row(2)];
    expect(ids(sortJournalRows(rows, 'created', 'desc'))).toEqual([3, 2, 1]);
    expect(ids(sortJournalRows(rows, 'created', 'asc'))).toEqual([1, 2, 3]);
  });
  it('orders money by exact decimal value, not as text', () => {
    const rows = [
      row(1, { netPnl: '9' }),
      row(2, { netPnl: '10' }),
      row(3, { netPnl: '-5.5' }),
      row(4, { netPnl: '-100' }),
      row(5, { netPnl: '0.00000001' }),
    ];
    expect(ids(sortJournalRows(rows, 'pnl', 'desc'))).toEqual([2, 1, 5, 3, 4]);
    expect(ids(sortJournalRows(rows, 'pnl', 'asc'))).toEqual([4, 3, 5, 1, 2]);
  });
  it('orders R the same way', () => {
    const rows = [
      row(1, { netR: '0.5000' }),
      row(2, { netR: '-1.2500' }),
      row(3, { netR: '2.0000' }),
    ];
    expect(ids(sortJournalRows(rows, 'r', 'desc'))).toEqual([3, 1, 2]);
  });
  it('rows without a value come last in either direction', () => {
    const rows = [row(1), row(2, { netPnl: '5' }), row(3, { netPnl: '-5' })];
    expect(ids(sortJournalRows(rows, 'pnl', 'desc'))).toEqual([2, 3, 1]);
    expect(ids(sortJournalRows(rows, 'pnl', 'asc'))).toEqual([3, 2, 1]);
  });
  it('orders status by the trade life cycle and symbol A to Z ignoring case', () => {
    const rows = [
      row(1, { status: 'closed', symbol: 'ethusdt' }),
      row(2, { status: 'planned', symbol: 'BTCUSDT' }),
      row(3, { status: 'cancelled', symbol: 'Adausdt' }),
      row(4, { status: 'open', symbol: 'xrpusdt' }),
    ];
    expect(ids(sortJournalRows(rows, 'status', 'asc'))).toEqual([2, 4, 1, 3]);
    expect(ids(sortJournalRows(rows, 'symbol', 'asc'))).toEqual([3, 2, 1, 4]);
  });
  it('ties are broken by id, newest first, so the order is repeatable', () => {
    const rows = [row(1, { netPnl: '5' }), row(2, { netPnl: '5' }), row(3, { netPnl: '5' })];
    expect(ids(sortJournalRows(rows, 'pnl', 'desc'))).toEqual([3, 2, 1]);
    expect(ids(sortJournalRows(rows, 'pnl', 'asc'))).toEqual([3, 2, 1]);
  });
  it('does not change the input array', () => {
    const rows = [row(1), row(2)];
    sortJournalRows(rows, 'created', 'asc');
    expect(ids(rows)).toEqual([1, 2]);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 60 }, (_, i) => i + 1);
  it('cuts pages of 25', () => {
    expect(PAGE_SIZE).toBe(25);
    const p1 = paginate(items, 1);
    expect(p1).toMatchObject({ page: 1, pages: 3, total: 60, pageSize: 25 });
    expect(p1.items).toHaveLength(25);
    expect(paginate(items, 3).items).toEqual(items.slice(50));
  });
  it('a page past the end shows the last page, page 0 shows the first', () => {
    expect(paginate(items, 99).page).toBe(3);
    expect(paginate(items, 0).page).toBe(1);
  });
  it('an empty list has one empty page', () => {
    expect(paginate([], 1)).toEqual({ items: [], page: 1, pages: 1, total: 0, pageSize: 25 });
  });
  it('exactly one full page is one page', () => {
    expect(paginate(items.slice(0, 25), 1).pages).toBe(1);
    expect(paginate(items.slice(0, 26), 1).pages).toBe(2);
  });
});

describe('more table cases', () => {
  it('repeated URL parameters (arrays) never throw: the first value is used', () => {
    const q = parseJournalQuery({
      symbol: ['btc', 'eth'],
      page: ['2', '3'],
      setup: ['1', '2'],
      status: ['closed', 'open'],
      sort: ['pnl'],
    });
    expect(q).toMatchObject({ symbol: 'btc', page: 2, setupId: 1, status: 'closed', sort: 'pnl' });
    expect(parseJournalQuery({ symbol: [] }).symbol).toBeNull();
  });
  it('rows without a date come last for opened, closed and date, in both directions', () => {
    const rows = [
      row(1),
      row(2, { openedAt: '2026-03-02T00:00:00.000Z' }),
      row(3, { openedAt: '2026-03-01T00:00:00.000Z' }),
    ];
    expect(ids(sortJournalRows(rows, 'opened', 'desc'))).toEqual([2, 3, 1]);
    expect(ids(sortJournalRows(rows, 'opened', 'asc'))).toEqual([3, 2, 1]);
    const closed = [row(1), row(2, { closedAt: '2026-03-02T00:00:00.000Z' })];
    expect(ids(sortJournalRows(closed, 'closed', 'asc'))).toEqual([2, 1]);
  });
  it('"date" is the close time of a closed trade and the opening time of the others', () => {
    const rows = [
      row(1, {
        status: 'closed',
        openedAt: '2026-01-01T00:00:00.000Z',
        closedAt: '2026-03-05T00:00:00.000Z',
      }),
      row(2, { status: 'open', openedAt: '2026-03-03T00:00:00.000Z' }),
      row(3, { status: 'planned' }),
    ];
    expect(ids(sortJournalRows(rows, 'date', 'desc'))).toEqual([1, 2, 3]);
    expect(ids(sortJournalRows(rows, 'date', 'asc'))).toEqual([2, 1, 3]);
  });
  it('two rows with no value are ordered by id, newest first', () => {
    expect(ids(sortJournalRows([row(1), row(2)], 'pnl', 'asc'))).toEqual([2, 1]);
  });
  it('an unknown status sorts after every known one', () => {
    const rows = [
      row(1, { status: 'weird' }),
      row(2, { status: 'cancelled' }),
      row(3, { status: 'planned' }),
    ];
    expect(ids(sortJournalRows(rows, 'status', 'asc'))).toEqual([3, 2, 1]);
  });
  it('symbols that differ only in case tie, then newest id first', () => {
    const rows = [row(1, { symbol: 'btc' }), row(2, { symbol: 'BTC' })];
    expect(ids(sortJournalRows(rows, 'symbol', 'asc'))).toEqual([2, 1]);
  });
  it('a setup id is read as written: "007" is 7 and "0" is 0', () => {
    expect(parseJournalQuery({ setup: '007' }).setupId).toBe(7);
    expect(parseJournalQuery({ setup: '0' }).setupId).toBe(0);
  });
});
