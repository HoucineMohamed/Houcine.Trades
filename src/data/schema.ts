import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
// Relative imports on purpose: drizzle-kit loads this file without the "@/" alias.
import { ACCOUNT_MODES } from '../domain/accounts/account';
import { HALT_KINDS, RISK_EVENT_KINDS, VERDICT_STAGES } from '../domain/risk/kinds';
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
    // Frozen copy of the stop when the trade opened (see the triggers in the migration). R uses it.
    initialStopLoss: text('initial_stop_loss'),
    // When the trade was RECORDED as closed in the journal (set by the closing write, frozen by a
    // trigger). The risk engine uses it, with closed_at, to decide what counts as "today".
    closedRecordedAt: text('closed_recorded_at'),
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

/** Per-account risk settings. JSON text, validated by the domain whenever it is loaded. */
export const riskSettings = sqliteTable('risk_settings', {
  accountId: integer('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'restrict' }),
  settingsJson: text('settings_json').notNull(),
  /** Loosening changes waiting for their effective time (JSON). */
  pendingJson: text('pending_json').notNull().default('{}'),
  updatedAt: text('updated_at').notNull(),
});

/** Append-only log of risk events (triggers refuse UPDATE and DELETE). */
export const riskEvents = sqliteTable(
  'risk_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: RISK_EVENT_KINDS }).notNull(),
    haltKind: text('halt_kind', { enum: HALT_KINDS }),
    tradeId: integer('trade_id').references(() => trades.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull().default(''),
    detailsJson: text('details_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
  },
  () => [
    index('risk_events_account_id_idx').on(sql`account_id`, sql`id`),
    check('risk_events_kind_check', inList('kind', RISK_EVENT_KINDS)),
    check(
      'risk_events_halt_kind_check',
      sql.raw(`halt_kind IS NULL OR halt_kind IN (${HALT_KINDS.map((k) => `'${k}'`).join(', ')})`),
    ),
  ],
);

/** Append-only risk verdict snapshots, one per trade at creation and one at opening. */
export const riskVerdicts = sqliteTable(
  'risk_verdicts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tradeId: integer('trade_id')
      .notNull()
      .references(() => trades.id, { onDelete: 'restrict' }),
    stage: text('stage', { enum: VERDICT_STAGES }).notNull(),
    /** 1 = approved by the risk engine, 0 = refused (so the trade was logged by override). */
    approved: integer('approved').notNull(),
    violationCodes: text('violation_codes').notNull(),
    warningCodes: text('warning_codes').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    /** Set when a refused plan was logged anyway. */
    overrideReason: text('override_reason'),
    createdAt: text('created_at').notNull(),
  },
  () => [
    index('risk_verdicts_trade_id_idx').on(sql`trade_id`),
    check('risk_verdicts_stage_check', inList('stage', VERDICT_STAGES)),
    check('risk_verdicts_approved_check', sql.raw('approved IN (0, 1)')),
    // A refused verdict can only exist together with an override reason.
    check(
      'risk_verdicts_override_check',
      sql.raw('approved = 1 OR (override_reason IS NOT NULL AND length(override_reason) > 0)'),
    ),
  ],
);

export type RiskSettingsRow = typeof riskSettings.$inferSelect;
export type RiskEventRow = typeof riskEvents.$inferSelect;
export type RiskVerdictRow = typeof riskVerdicts.$inferSelect;
