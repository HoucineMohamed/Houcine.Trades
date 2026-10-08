/** Kept with no imports so the database schema (loaded by drizzle-kit) can use it. */
export const NOTIFICATION_CATEGORIES = ['risk', 'security', 'analyst', 'system'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);

export const EVENT_KINDS = [
  // risk
  'daily_loss_usage',
  'open_risk_usage',
  'open_trades_usage',
  'drawdown_usage',
  'halt_started_daily_loss',
  'halt_started_drawdown',
  'halt_started_manual',
  'halt_cleared',
  'drawdown_reset_refused',
  'override_logged',
  'rule_violation_trade_logged',
  // security
  'login_failures_burst',
  'login_throttled',
  'login_success',
  'recovery_code_used',
  'password_changed',
  'security_settings_changed',
  'logout_everywhere',
  'step_up_failed',
  // analyst
  'analyst_daily_calls_usage',
  'analyst_monthly_calls_usage',
  'analyst_monthly_cost_usage',
  'analyst_call_failed',
  // system
  'notifications_switched_off',
  'test_message',
  'flood_summary',
  'backup_failed', // reserved: defined, nothing produces it yet (module 8)
  'market_data_stale', // reserved: defined, nothing produces it yet (no market data exists)
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const RESERVED_KINDS: readonly EventKind[] = ['backup_failed', 'market_data_stale'];

/** The kinds that carry a usage level (50, 80 or 100 percent of a limit). */
export const USAGE_KINDS = [
  'daily_loss_usage',
  'open_risk_usage',
  'open_trades_usage',
  'drawdown_usage',
  'analyst_daily_calls_usage',
  'analyst_monthly_calls_usage',
  'analyst_monthly_cost_usage',
] as const satisfies readonly EventKind[];
export type UsageKind = (typeof USAGE_KINDS)[number];

export const USAGE_LEVELS = [50, 80, 100] as const;
export type UsageLevel = (typeof USAGE_LEVELS)[number];

export const DELIVERY_STATUSES = ['sending', 'sent', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Short codes only: a delivery error is never stored as free text (it could hold a URL or token). */
export const ERROR_CODES = [
  'timeout',
  'network',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'bad_request',
  'server_error',
  'bad_response',
  'conflict',
  'not_configured',
  'unexpected',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const CHANNEL_NAMES = ['telegram', 'fake'] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];
