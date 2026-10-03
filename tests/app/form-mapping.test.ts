import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/domain/errors';
import { NotFoundError } from '@/data/errors';
import {
  blank,
  errorMessages,
  formatLocal,
  localToUtc,
  orNull,
  orUndefined,
  toId,
  utcToLocalInput,
} from '@/app/_lib/form';
import {
  closeInputFromForm,
  createInputFromForm,
  editPatchFromForm,
  openInputFromForm,
} from '@/app/trades/mapping';
import { buildNewTrade } from '@/domain/trades/lifecycle';

describe('form helpers', () => {
  it('blank / orUndefined / orNull', () => {
    expect(blank(undefined)).toBe(true);
    expect(blank('  ')).toBe(true);
    expect(blank('0')).toBe(false);
    expect(orUndefined('')).toBeUndefined();
    expect(orUndefined('5')).toBe('5');
    expect(orNull(' ')).toBeNull();
    expect(orNull('5')).toBe('5');
  });

  it('toId only accepts whole numbers', () => {
    expect(toId('12')).toBe(12);
    expect(toId(' 7 ')).toBe(7);
    for (const bad of [undefined, '', 'abc', '1.5', '-1', '1e3']) expect(toId(bad)).toBeUndefined();
  });

  it('local time <-> UTC round trip (uses the computer time zone)', () => {
    const utc = localToUtc('2026-10-03T18:21');
    expect(utc).toMatch(/^2026-10-0[34]T\d{2}:\d{2}:00\.000Z$/);
    expect(utcToLocalInput(utc)).toBe('2026-10-03T18:21');
    expect(formatLocal(utc)).toBe('2026-10-03 18:21');
  });

  it('localToUtc passes bad text through so the domain can reject it', () => {
    expect(localToUtc('tomorrow')).toBe('tomorrow');
    expect(localToUtc('')).toBeUndefined();
    expect(utcToLocalInput(null)).toBe('');
    expect(formatLocal(undefined)).toBe('');
  });

  it('errorMessages formats known errors and re-throws unknown ones', () => {
    expect(errorMessages(new ValidationError([{ field: 'size', message: 'bad' }]))).toEqual([
      'size: bad',
    ]);
    expect(errorMessages(new NotFoundError('Trade 1'))).toEqual(['Trade 1 was not found']);
    expect(() => errorMessages(new Error('boom'))).toThrow('boom');
  });
});

describe('createInputFromForm', () => {
  const form = {
    accountId: '1',
    setupId: '',
    symbol: 'btcusdt',
    assetClass: 'crypto',
    direction: 'long',
    status: 'planned',
    plannedEntry: '100',
    stopLoss: '95',
    takeProfit: '',
    size: '0.5',
    quoteCurrency: 'usdt',
    entryPrice: '',
    openedAt: '',
    fees: '',
    feesCurrency: '',
    planNotes: '',
    emotion: '',
    screenshotPath: '',
  };

  it('maps blanks to defaults and produces a valid trade', () => {
    const trade = buildNewTrade(createInputFromForm(form));
    expect(trade).toMatchObject({
      setupId: null,
      takeProfit: null,
      fees: '0',
      feesCurrency: 'USDT',
      screenshotPath: null,
    });
  });

  it('a blank stop-loss is reported as required (rule 4)', () => {
    expect(() => buildNewTrade(createInputFromForm({ ...form, stopLoss: '' }))).toThrow(
      /Stop-loss is required/,
    );
  });

  it('a blank account is reported as required', () => {
    expect(() => buildNewTrade(createInputFromForm({ ...form, accountId: '' }))).toThrow(
      /Account is required/,
    );
  });

  it('keeps an open trade with entry and time', () => {
    const trade = buildNewTrade(
      createInputFromForm({
        ...form,
        status: 'open',
        entryPrice: '101',
        openedAt: '2026-10-03T18:21',
      }),
    );
    expect(trade).toMatchObject({ status: 'open', entryPrice: '101' });
    expect(trade.openedAt).toMatch(/^2026-10-0[34]T/);
  });
});

describe('edit / open / close mapping', () => {
  it('edit patch only includes submitted fields (locked fields are not sent)', () => {
    expect(editPatchFromForm({ reviewNotes: 'ok', emotion: '' })).toEqual({
      reviewNotes: 'ok',
      emotion: '',
    });
  });

  it('edit patch: blank take-profit clears it, blank fees are left alone', () => {
    expect(editPatchFromForm({ takeProfit: '', fees: '', stopLoss: '90', setupId: '' })).toEqual({
      takeProfit: null,
      fees: undefined,
      stopLoss: '90',
      setupId: null,
    });
  });

  it('open and close input', () => {
    expect(openInputFromForm({ entryPrice: '100', openedAt: '' })).toEqual({
      entryPrice: '100',
      openedAt: undefined,
    });
    expect(closeInputFromForm({ exitPrice: '', closedAt: '', fees: '' })).toEqual({
      exitPrice: undefined,
      closedAt: undefined,
      fees: undefined,
    });
  });
});
