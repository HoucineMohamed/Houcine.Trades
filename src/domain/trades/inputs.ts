import { z } from 'zod';
import {
  currencyCode,
  decimalField,
  nonEmptyText,
  screenshotField,
  text,
  timestampField,
} from '../fields';
import { ASSET_CLASSES, DIRECTIONS, STATUSES } from './types';

/**
 * Input schemas for trades (zod, used at the boundary). They check the shape of each field and
 * normalise it. Cross-field rules (stop side, status rules) live in validation.ts.
 * All schemas are strict: unknown fields are rejected, not silently ignored.
 */

const id = (label: string) =>
  z
    .number({ error: `${label} is required` })
    .int(`${label} must be a whole number`)
    .positive(`${label} is invalid`);

const optionalId = (label: string) =>
  id(label)
    .nullish()
    .transform((v) => v ?? null);

const symbol = nonEmptyText('Symbol', 30)
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._/:-]*$/, 'Symbol may contain only letters, digits and . _ / : -');

const assetClass = z.enum(ASSET_CLASSES, {
  error: `Asset class must be one of: ${ASSET_CLASSES.join(', ')}`,
});
const direction = z.enum(DIRECTIONS, { error: 'Direction must be long or short' });

const screenshotOrNull = screenshotField()
  .nullish()
  .transform((v) => (v === undefined || v === null || v === '' ? null : v));

export const createTradeSchema = z
  .strictObject({
    accountId: id('Account'),
    setupId: optionalId('Setup'),
    symbol,
    assetClass,
    direction,
    status: z
      .enum(['planned', 'open'], { error: 'A new trade can only be created as planned or open' })
      .default('planned'),
    plannedEntry: decimalField('Planned entry', 'positive'),
    stopLoss: decimalField('Stop-loss', 'positive'),
    takeProfit: decimalField('Take-profit', 'positive')
      .nullish()
      .transform((v) => v ?? null),
    size: decimalField('Size', 'positive'),
    quoteCurrency: currencyCode('Quote currency'),
    entryPrice: decimalField('Entry price', 'positive')
      .nullish()
      .transform((v) => v ?? null),
    openedAt: timestampField('Opened time')
      .nullish()
      .transform((v) => v ?? null),
    fees: decimalField('Fees', 'nonNegative').default('0'),
    feesCurrency: currencyCode('Fees currency').nullish(),
    planNotes: text('Plan notes', 5000).default(''),
    emotion: text('Emotion', 200).default(''),
    screenshotPath: screenshotOrNull,
  })
  .transform((v) => ({ ...v, feesCurrency: v.feesCurrency ?? v.quoteCurrency }));

export type CreateTradeInput = z.input<typeof createTradeSchema>;

export const openTradeSchema = z.strictObject({
  entryPrice: decimalField('Entry price', 'positive'),
  openedAt: timestampField('Opened time'),
});

export const closeTradeSchema = z.strictObject({
  exitPrice: decimalField('Exit price', 'positive'),
  closedAt: timestampField('Closed time'),
  fees: decimalField('Fees', 'nonNegative').optional(),
  feesCurrency: currencyCode('Fees currency').optional(),
  reviewNotes: text('Review notes', 5000).optional(),
  emotion: text('Emotion', 200).optional(),
});

export const editTradeSchema = z.strictObject({
  setupId: optionalId('Setup').optional(),
  symbol: symbol.optional(),
  assetClass: assetClass.optional(),
  direction: direction.optional(),
  plannedEntry: decimalField('Planned entry', 'positive').optional(),
  stopLoss: decimalField('Stop-loss', 'positive').optional(),
  takeProfit: decimalField('Take-profit', 'positive').nullable().optional(),
  size: decimalField('Size', 'positive').optional(),
  quoteCurrency: currencyCode('Quote currency').optional(),
  fees: decimalField('Fees', 'nonNegative').optional(),
  feesCurrency: currencyCode('Fees currency').optional(),
  planNotes: text('Plan notes', 5000).optional(),
  reviewNotes: text('Review notes', 5000).optional(),
  emotion: text('Emotion', 200).optional(),
  screenshotPath: screenshotField()
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v)),
});

export type EditTradeInput = z.input<typeof editTradeSchema>;

/** Filters for listing trades. All optional; symbol is matched exactly (after upper-casing). */
export const tradeFilterSchema = z.strictObject({
  accountId: id('Account').optional(),
  status: z.enum(STATUSES, { error: `Status must be one of: ${STATUSES.join(', ')}` }).optional(),
  symbol: symbol.optional(),
});

export type TradeFilter = z.input<typeof tradeFilterSchema>;
