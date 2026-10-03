import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
// Relative imports on purpose: drizzle-kit loads this file without the "@/" alias.
import { ACCOUNT_MODES } from '../domain/accounts/account';
import { ASSET_CLASSES, DIRECTIONS, STATUSES } from '../domain/trades/types';

/**
 * Database tables. Money rule: every amount, price, size and fee is TEXT holding a decimal
 * string. Never do SQL arithmetic or numeric comparison on those columns; the domain code does
 * the math with decimal.js. Timestamps are TEXT in canonical UTC ISO form.
 */

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(', ')})`);

export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    mode: text('mode', { enum: ACCOUNT_MODES }).notNull().default('paper'),
    baseCurrency: text('base_currency').notNull(),
    startingBalance: text('starting_balance').notNull(),
    createdAt: text('created_at').notNull(),
  },
  () => [check('accounts_mode_check', inList('mode', ACCOUNT_MODES))],
);

export const setups = sqliteTable('setups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  createdAt: text('created_at').notNull(),
});

export const trades = sqliteTable(
  'trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    setupId: integer('setup_id').references(() => setups.id, { onDelete: 'restrict' }),
    symbol: text('symbol').notNull(),
    assetClass: text('asset_class', { enum: ASSET_CLASSES }).notNull(),
    direction: text('direction', { enum: DIRECTIONS }).notNull(),
    status: text('status', { enum: STATUSES }).notNull(),
    plannedEntry: text('planned_entry').notNull(),
    // Project rule 4: a stop-loss is mandatory on every trade (NOT NULL, and never empty).
    stopLoss: text('stop_loss').notNull(),
    takeProfit: text('take_profit'),
    size: text('size').notNull(),
    quoteCurrency: text('quote_currency').notNull(),
    entryPrice: text('entry_price'),
    exitPrice: text('exit_price'),
    fees: text('fees').notNull().default('0'),
    feesCurrency: text('fees_currency').notNull(),
    openedAt: text('opened_at'),
    closedAt: text('closed_at'),
    planNotes: text('plan_notes').notNull().default(''),
    reviewNotes: text('review_notes').notNull().default(''),
    emotion: text('emotion').notNull().default(''),
    screenshotPath: text('screenshot_path'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('trades_account_id_idx').on(t.accountId),
    index('trades_status_idx').on(t.status),
    index('trades_symbol_idx').on(t.symbol),
    index('trades_opened_at_idx').on(t.openedAt),
    check('trades_direction_check', inList('direction', DIRECTIONS)),
    check('trades_status_check', inList('status', STATUSES)),
    check('trades_asset_class_check', inList('asset_class', ASSET_CLASSES)),
    check('trades_stop_loss_check', sql.raw(`length(stop_loss) > 0`)),
    // Last line of defence behind the domain rules: open/closed trades need their entry data.
    check(
      'trades_entry_data_check',
      sql.raw(
        `status NOT IN ('open', 'closed') OR (entry_price IS NOT NULL AND opened_at IS NOT NULL)`,
      ),
    ),
    check(
      'trades_exit_data_check',
      sql.raw(`status <> 'closed' OR (exit_price IS NOT NULL AND closed_at IS NOT NULL)`),
    ),
  ],
);

export type AccountRow = typeof accounts.$inferSelect;
export type SetupRow = typeof setups.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;
