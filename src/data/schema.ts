import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
// Relative imports on purpose: drizzle-kit loads this file without the "@/" alias.
import { ACCOUNT_MODES } from '../domain/accounts/account';
import { AI_USAGE_STATUSES, ANALYST_KINDS } from '../domain/analyst/kinds';
import { ATTEMPT_KINDS, AUTH_EVENT_KINDS } from '../domain/auth/kinds';
import { BACKUP_ERROR_CODES, BACKUP_KINDS, BACKUP_OUTCOMES } from '../domain/hosting/kinds';
import {
  CHANNEL_NAMES,
  DELIVERY_STATUSES,
  ERROR_CODES,
  EVENT_KINDS,
  NOTIFICATION_CATEGORIES,
  SEVERITIES,
} from '../domain/notifications/kinds';
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

// ---------------------------------------------------------------------------------------------
// Authentication (module 4). See docs/security.md.
// ---------------------------------------------------------------------------------------------

/**
 * The single owner. `id` is always 1 (CHECK), so a second owner is impossible; a trigger also
 * forbids deleting the row. The only way to create or reset it is the command-line scripts.
 */
export const owner = sqliteTable(
  'owner',
  {
    id: integer('id').primaryKey(),
    /** argon2id hash. */
    passwordHash: text('password_hash').notNull(),
    /** AES-256-GCM blob (key derived from AUTH_SECRET). */
    totpSecretEnc: text('totp_secret_enc').notNull(),
    /** Newest authenticator time step ever accepted (replay protection). */
    totpLastStep: integer('totp_last_step'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    passwordChangedAt: text('password_changed_at').notNull(),
  },
  () => [check('owner_single_row_check', sql.raw('id = 1'))],
);

/** One-time recovery codes. Only a SHA-256 hash is stored. */
export const recoveryCodes = sqliteTable('recovery_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  codeHash: text('code_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  usedAt: text('used_at'),
  /** Set when a new set of codes replaced this one. */
  revokedAt: text('revoked_at'),
});

/** Server-side sessions. The browser holds a random token; only its SHA-256 hash is stored. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    /** When a fresh authenticator code was last entered in this session (step-up). */
    stepUpAt: text('step_up_at'),
    ip: text('ip').notNull().default(''),
    userAgent: text('user_agent').notNull().default(''),
    revokedAt: text('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  () => [index('sessions_revoked_at_idx').on(sql`revoked_at`)],
);

/** Append-only authentication log (triggers refuse UPDATE and DELETE). Never holds secrets. */
export const authEvents = sqliteTable(
  'auth_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: AUTH_EVENT_KINDS }).notNull(),
    createdAt: text('created_at').notNull(),
    sessionId: integer('session_id').references(() => sessions.id, { onDelete: 'restrict' }),
    ip: text('ip').notNull().default(''),
    userAgent: text('user_agent').notNull().default(''),
    /** A short generic code such as "invalid_credentials". Never a password, code or token. */
    detail: text('detail').notNull().default(''),
  },
  () => [check('auth_events_kind_check', inList('kind', AUTH_EVENT_KINDS))],
);

/**
 * Failed attempts that were actually processed (used for the progressive delays). Survives
 * restarts. Attempts rejected during a delay are NOT recorded here, so they cannot extend it.
 */
export const authAttempts = sqliteTable(
  'auth_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** "global" or "source:<key>". */
    bucket: text('bucket').notNull(),
    kind: text('kind', { enum: ATTEMPT_KINDS }).notNull(),
    atMs: integer('at_ms').notNull(),
  },
  () => [
    index('auth_attempts_bucket_idx').on(sql`bucket`, sql`at_ms`),
    check('auth_attempts_kind_check', inList('kind', ATTEMPT_KINDS)),
  ],
);

export type OwnerRow = typeof owner.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type AuthEventRow = typeof authEvents.$inferSelect;
export type RecoveryCodeRow = typeof recoveryCodes.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Analyst (module 6). See docs/analyst.md. No prompt, answer or secret is ever stored in the usage log.
// ---------------------------------------------------------------------------------------------

/** The single settings row (id is always 1): the privacy switch and the spend caps. */
export const aiSettings = sqliteTable(
  'ai_settings',
  {
    id: integer('id').primaryKey(),
    /** 1 = "Send journal data to the AI" is ON. Default OFF (no row means OFF). */
    consent: integer('consent').notNull().default(0),
    capsJson: text('caps_json').notNull(),
    /** Loosened caps waiting for their effective time (JSON). */
    pendingCapsJson: text('pending_caps_json').notNull().default('{}'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [
    check('ai_settings_single_row_check', sql.raw('id = 1')),
    check('ai_settings_consent_check', sql.raw('consent IN (0, 1)')),
  ],
);

/** Append-only log of requests that were actually sent (triggers refuse UPDATE and DELETE). */
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    createdAt: text('created_at').notNull(),
    feature: text('feature', { enum: ANALYST_KINDS }).notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    /** An ESTIMATE in USD (decimal text) from the price table. The console limit is the real stop. */
    estimatedCostUsd: text('estimated_cost_usd').notNull(),
    status: text('status', { enum: AI_USAGE_STATUSES }).notNull(),
  },
  () => [
    index('ai_usage_created_at_idx').on(sql`created_at`),
    check('ai_usage_feature_check', inList('feature', ANALYST_KINDS)),
    check('ai_usage_status_check', inList('status', AI_USAGE_STATUSES)),
    check('ai_usage_tokens_check', sql.raw('input_tokens >= 0 AND output_tokens >= 0')),
  ],
);

/** Append-only stored results, so they can be read again without paying twice. */
export const aiReviews = sqliteTable(
  'ai_reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ANALYST_KINDS }).notNull(),
    accountId: integer('account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    /** Weekly review: the date range (YYYY-MM-DD) and the one currency it covers. */
    rangeFrom: text('range_from'),
    rangeTo: text('range_to'),
    currency: text('currency'),
    /** What was asked, in words (plan summary or the scrubbed question). Never a secret. */
    subject: text('subject').notNull().default(''),
    /** SHA-256 of exactly what was sent. */
    inputHash: text('input_hash').notNull(),
    /** The validated output (JSON). Re-validated whenever it is read. */
    outputJson: text('output_json').notNull(),
    /** Figure and wording checks, plus whether the input was truncated (JSON). */
    checksJson: text('checks_json').notNull(),
    usageId: integer('usage_id')
      .notNull()
      .references(() => aiUsage.id, { onDelete: 'restrict' }),
    model: text('model').notNull(),
    createdAt: text('created_at').notNull(),
  },
  () => [
    index('ai_reviews_kind_idx').on(sql`kind`, sql`id`),
    check('ai_reviews_kind_check', inList('kind', ANALYST_KINDS)),
  ],
);

export type AiSettingsRow = typeof aiSettings.$inferSelect;
export type AiUsageRow = typeof aiUsage.$inferSelect;
export type AiReviewRow = typeof aiReviews.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Notifications (module 7). See docs/notifications.md. Events are RECORDED first (outbox) and
// delivered later. No message text is stored: it is rebuilt from the fixed templates.
// ---------------------------------------------------------------------------------------------

/** The single settings row (id 1): master switch, consent, category switches, minimum severity. */
export const notificationSettings = sqliteTable(
  'notification_settings',
  {
    id: integer('id').primaryKey(),
    /** 1 = "Send alerts to Telegram" is ON. Default OFF (no row means OFF). */
    master: integer('master').notNull().default(0),
    /** When the owner gave consent (the last time the switch was turned ON). */
    consentAt: text('consent_at'),
    categoriesJson: text('categories_json').notNull(),
    minSeverity: text('min_severity', { enum: SEVERITIES }).notNull().default('info'),
    /** Quieter changes waiting for their time (JSON). */
    pendingJson: text('pending_json').notNull().default('{}'),
    updatedAt: text('updated_at').notNull(),
  },
  () => [
    check('notification_settings_single_row_check', sql.raw('id = 1')),
    check('notification_settings_master_check', sql.raw('master IN (0, 1)')),
    check('notification_settings_severity_check', inList('min_severity', SEVERITIES)),
  ],
);

/** Collector bookkeeping: how far each log was read, and the last level seen per limit (mutable). */
export const notificationState = sqliteTable('notification_state', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Append-only: one row per event, unique dedupe key (triggers refuse UPDATE and DELETE). */
export const notificationEvents = sqliteTable(
  'notification_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: EVENT_KINDS }).notNull(),
    category: text('category', { enum: NOTIFICATION_CATEGORIES }).notNull(),
    severity: text('severity', { enum: SEVERITIES }).notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    /** An account NUMBER (never a name). */
    accountId: integer('account_id'),
    level: integer('level'),
    count: integer('count'),
    occurredAt: text('occurred_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  () => [
    index('notification_events_occurred_idx').on(sql`occurred_at`),
    check('notification_events_kind_check', inList('kind', EVENT_KINDS)),
    check('notification_events_category_check', inList('category', NOTIFICATION_CATEGORIES)),
    check('notification_events_severity_check', inList('severity', SEVERITIES)),
    check('notification_events_level_check', sql.raw('level IS NULL OR level IN (50, 80, 100)')),
  ],
);

/** Append-only: one row per delivery ATTEMPT. The current state is derived from the latest rows. */
export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => notificationEvents.id, { onDelete: 'restrict' }),
    channel: text('channel', { enum: CHANNEL_NAMES }).notNull(),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull(),
    at: text('at').notNull(),
    /** A short code only (never free text: it could hold a URL or a token). */
    errorCode: text('error_code', { enum: ERROR_CODES }),
    retryAfterS: integer('retry_after_s'),
  },
  () => [
    index('notification_deliveries_event_idx').on(sql`event_id`, sql`id`),
    check('notification_deliveries_channel_check', inList('channel', CHANNEL_NAMES)),
    check('notification_deliveries_status_check', inList('status', DELIVERY_STATUSES)),
    check(
      'notification_deliveries_error_check',
      sql.raw(
        `error_code IS NULL OR error_code IN (${ERROR_CODES.map((c) => `'${c}'`).join(', ')})`,
      ),
    ),
  ],
);

export type NotificationSettingsRow = typeof notificationSettings.$inferSelect;
export type NotificationEventRow = typeof notificationEvents.$inferSelect;
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Hosting (module 8). See docs/deploy.md. One row per backup ATTEMPT (append-only). No secret, key
// or object content is stored: the object key only holds a time, a kind and a migration count.
// ---------------------------------------------------------------------------------------------

export const backupRuns = sqliteTable(
  'backup_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: BACKUP_KINDS }).notNull(),
    outcome: text('outcome', { enum: BACKUP_OUTCOMES }).notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at').notNull(),
    /** The object key (time, kind, migration count), or null when the backup never got that far. */
    objectKey: text('object_key'),
    sizeBytes: integer('size_bytes'),
    /** SHA-256 of the encrypted object, as hex. */
    sha256: text('sha256'),
    /** A SHORT CODE when the backup failed (never free text: it could hold a URL). */
    errorCode: text('error_code', { enum: BACKUP_ERROR_CODES }),
  },
  () => [
    index('backup_runs_finished_idx').on(sql`finished_at`),
    check('backup_runs_kind_check', inList('kind', BACKUP_KINDS)),
    check('backup_runs_outcome_check', inList('outcome', BACKUP_OUTCOMES)),
    check(
      'backup_runs_error_check',
      sql.raw(
        `error_code IS NULL OR error_code IN (${BACKUP_ERROR_CODES.map((c) => `'${c}'`).join(', ')})`,
      ),
    ),
    check(
      'backup_runs_outcome_fields_check',
      sql.raw(
        "(outcome = 'ok' AND object_key IS NOT NULL AND sha256 IS NOT NULL AND error_code IS NULL) OR (outcome = 'failed' AND error_code IS NOT NULL)",
      ),
    ),
  ],
);

export type BackupRunRow = typeof backupRuns.$inferSelect;
