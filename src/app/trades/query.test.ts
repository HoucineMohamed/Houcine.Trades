import { describe, expect, it } from 'vitest';
import { DEFAULT_QUERY, parseJournalQuery } from '@/domain/trades/table';
import { ariaSort, journalHref, sortHref } from './query';

describe('journalHref', () => {
  it('the default query is the plain list', () => {
    expect(journalHref(DEFAULT_QUERY)).toBe('/trades');
  });
  it('writes only what differs from the default, and round-trips through the parser', () => {
    const q = parseJournalQuery({
      status: 'closed',
      direction: 'short',
      symbol: 'ETHUSDT',
      setup: '3',
      override: '1',
      sort: 'pnl',
      dir: 'asc',
      page: '2',
    });
    const href = journalHref(q);
    expect(href).toBe(
      '/trades?status=closed&direction=short&symbol=ETHUSDT&setup=3&override=1&sort=pnl&dir=asc&page=2',
    );
    const back = Object.fromEntries(new URL(href, 'http://x').searchParams);
    expect(parseJournalQuery(back)).toEqual(q);
  });
  it('encodes the symbol safely', () => {
    expect(journalHref({ ...DEFAULT_QUERY, symbol: 'A&B=C' })).toBe('/trades?symbol=A%26B%3DC');
  });
  it('a patch can change one thing', () => {
    expect(journalHref(DEFAULT_QUERY, { status: 'open', page: 3 })).toBe(
      '/trades?status=open&page=3',
    );
  });
});

describe('sort links', () => {
  it('the first click uses the natural direction, the second flips it, and the page resets', () => {
    const q = { ...DEFAULT_QUERY, page: 4 };
    expect(sortHref(q, 'pnl')).toBe('/trades?sort=pnl');
    expect(sortHref({ ...q, sort: 'pnl', dir: 'desc' }, 'pnl')).toBe('/trades?sort=pnl&dir=asc');
    expect(sortHref(q, 'symbol')).toBe('/trades?sort=symbol');
    expect(sortHref({ ...q, sort: 'symbol', dir: 'asc' }, 'symbol')).toBe(
      '/trades?sort=symbol&dir=desc',
    );
  });
  it('aria-sort says which column is sorted and how', () => {
    expect(ariaSort(DEFAULT_QUERY, 'created')).toBe('descending');
    expect(ariaSort({ ...DEFAULT_QUERY, sort: 'symbol', dir: 'asc' }, 'symbol')).toBe('ascending');
    expect(ariaSort(DEFAULT_QUERY, 'pnl')).toBe('none');
  });
});
