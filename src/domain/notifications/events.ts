import {
  type EventKind,
  type NotificationCategory,
  type Severity,
  USAGE_KINDS,
  type UsageKind,
  type UsageLevel,
} from './kinds';

/**
 * Notification events are DERIVED from records that already exist (risk events, verdicts, the
 * authentication log, the analyst usage log) by the pure functions below. Nothing in the risk,
 * auth or analyst code emits anything: this module only reads their records.
 */

export const KIND_CATEGORY: Record<EventKind, NotificationCategory> = {
  daily_loss_usage: 'risk',
  open_risk_usage: 'risk',
  open_trades_usage: 'risk',
  drawdown_usage: 'risk',
  halt_started_daily_loss: 'risk',
  halt_started_drawdown: 'risk',
  halt_started_manual: 'risk',
  halt_cleared: 'risk',
  drawdown_reset_refused: 'risk',
  override_logged: 'risk',
  rule_violation_trade_logged: 'risk',
  login_failures_burst: 'security',
  login_throttled: 'security',
  login_success: 'security',
  recovery_code_used: 'security',
  password_changed: 'security',
  security_settings_changed: 'security',
  logout_everywhere: 'security',
  step_up_failed: 'security',
  analyst_daily_calls_usage: 'analyst',
  analyst_monthly_calls_usage: 'analyst',
  analyst_monthly_cost_usage: 'analyst',
  analyst_call_failed: 'analyst',
  notifications_switched_off: 'system',
  test_message: 'system',
  flood_summary: 'system',
  backup_failed: 'system',
  market_data_stale: 'system',
};

const FIXED_SEVERITY: Record<Exclude<EventKind, UsageKind>, Severity> = {
  halt_started_daily_loss: 'critical',
  halt_started_drawdown: 'critical',
  halt_started_manual: 'warning',
  halt_cleared: 'info',
  drawdown_reset_refused: 'warning',
  override_logged: 'warning',
  rule_violation_trade_logged: 'warning',
  login_failures_burst: 'warning',
  login_throttled: 'warning',
  login_success: 'info',
  recovery_code_used: 'critical',
  password_changed: 'warning',
  security_settings_changed: 'warning',
  logout_everywhere: 'warning',
  step_up_failed: 'warning',
  analyst_call_failed: 'info',
  notifications_switched_off: 'critical',
  test_message: 'info',
  flood_summary: 'info',
  backup_failed: 'warning',
  market_data_stale: 'warning',
};

export function severityOf(kind: EventKind, level: number | null): Severity {
  if (Object.hasOwn(FIXED_SEVERITY, kind))
    return FIXED_SEVERITY[kind as keyof typeof FIXED_SEVERITY];
  if (!(USAGE_KINDS as readonly string[]).includes(kind)) return 'info'; // an unknown kind is never louder than info
  const analyst = kind.startsWith('analyst_');
  if (level === 100) return analyst ? 'warning' : 'critical';
  if (level === 80) return 'warning';
  return 'info';
}

/** Never held back by the category or severity settings (they are about the alerts themselves). */
export const FILTER_EXEMPT_KINDS: readonly EventKind[] = [
  'test_message',
  'flood_summary',
  'notifications_switched_off',
];
/** Not counted against the per-hour ceiling (they ARE the flood protection, or a one-off). */
export const QUOTA_EXEMPT_KINDS: readonly EventKind[] = ['flood_summary', 'test_message'];

export interface NotificationEvent {
  kind: EventKind;
  category: NotificationCategory;
  severity: Severity;
  /** Unique: the same fact can be recorded once only. */
  dedupeKey: string;
  /** When the thing happened (ISO, UTC). */
  occurredAt: string;
  /** The account number (an integer, never a name), when the event is about one account. */
  accountId: number | null;
  /** 50, 80 or 100 for usage events. */
  level: UsageLevel | null;
  /** A count for summaries ("N failed sign-ins", "N more events"). */
  count: number | null;
}

export function makeEvent(input: {
  kind: EventKind;
  dedupeKey: string;
  occurredAt: string;
  accountId?: number | null;
  level?: UsageLevel | null;
  count?: number | null;
}): NotificationEvent {
  const level = input.level ?? null;
  return {
    kind: input.kind,
    category: KIND_CATEGORY[input.kind],
    severity: severityOf(input.kind, level),
    dedupeKey: input.dedupeKey,
    occurredAt: input.occurredAt,
    accountId: input.accountId ?? null,
    level,
    count: input.count ?? null,
  };
}

// ---- mapping from existing records ---------------------------------------------------------------

export interface RiskEventRow {
  id: number;
  accountId: number;
  kind: string;
  haltKind: string | null;
  createdAt: string;
}

/** `halt`, `reset_refused` and `override` rows. (A cleared halt comes from a state change, see below.) */
export function eventFromRiskEvent(row: RiskEventRow): NotificationEvent | null {
  const base = {
    dedupeKey: `risk_event:${row.id}`,
    occurredAt: row.createdAt,
    accountId: row.accountId,
  };
  if (row.kind === 'halt') {
    const kind: EventKind | null =
      row.haltKind === 'daily_loss'
        ? 'halt_started_daily_loss'
        : row.haltKind === 'drawdown'
          ? 'halt_started_drawdown'
          : row.haltKind === 'manual'
            ? 'halt_started_manual'
            : null;
    return kind ? makeEvent({ kind, ...base }) : null;
  }
  if (row.kind === 'reset_refused') return makeEvent({ kind: 'drawdown_reset_refused', ...base });
  if (row.kind === 'override') return makeEvent({ kind: 'override_logged', ...base });
  return null;
}

export interface VerdictRow {
  id: number;
  approved: number;
  accountId: number;
  createdAt: string;
}

/** A trade that broke a rule and was logged anyway (only possible by override). */
export function eventFromVerdict(row: VerdictRow): NotificationEvent | null {
  if (row.approved !== 0) return null;
  return makeEvent({
    kind: 'rule_violation_trade_logged',
    dedupeKey: `verdict:${row.id}`,
    occurredAt: row.createdAt,
    accountId: row.accountId,
  });
}

export interface AuthEventRow {
  id: number;
  kind: string;
  createdAt: string;
}

const AUTH_KIND_MAP: Record<string, EventKind | null> = {
  login_success: 'login_success',
  rate_limit_tripped: 'login_throttled',
  recovery_used: 'recovery_code_used',
  password_changed: 'password_changed',
  recovery_regenerated: 'security_settings_changed',
  ai_consent_on: 'security_settings_changed',
  ai_consent_off: 'security_settings_changed',
  ai_caps_changed: 'security_settings_changed',
  notifications_settings_changed: 'security_settings_changed',
  logout_all: 'logout_everywhere',
  step_up_failure: 'step_up_failed',
  // login_failure: summarized (see loginBurstEvents). notifications_off: the final notice covers it.
  // notifications_on: you are present and just did it (the baseline starts from that moment).
};

export function eventFromAuthEvent(row: AuthEventRow): NotificationEvent | null {
  const kind = AUTH_KIND_MAP[row.kind];
  if (!kind) return null;
  return makeEvent({ kind, dedupeKey: `auth_event:${row.id}`, occurredAt: row.createdAt });
}

// ---- failed-login bursts ---------------------------------------------------------------------------

export const LOGIN_BURST_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_BURST_THRESHOLD = 3;
/** A burst is announced again when its count passes one of these (so 500 failures do not read as 3). */
export const LOGIN_BURST_BUCKETS = [3, 10, 30, 100] as const;

/**
 * Failed sign-ins are never sent one by one: every 15-minute window (UTC) with 3 or more failures
 * gives ONE event carrying the count. Computed from the log each time, so it is idempotent.
 */
export function loginBurstEvents(failureTimes: readonly string[]): NotificationEvent[] {
  const windows = new Map<number, number>();
  for (const iso of failureTimes) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    const start = Math.floor(t / LOGIN_BURST_WINDOW_MS) * LOGIN_BURST_WINDOW_MS;
    windows.set(start, (windows.get(start) ?? 0) + 1);
  }
  return [...windows.entries()]
    .filter(([, n]) => n >= LOGIN_BURST_THRESHOLD)
    .sort(([a], [b]) => a - b)
    .map(([start, n]) => {
      const bucket =
        [...LOGIN_BURST_BUCKETS].reverse().find((b) => n >= b) ?? LOGIN_BURST_THRESHOLD;
      return makeEvent({
        kind: 'login_failures_burst',
        dedupeKey: `login_burst:${new Date(start).toISOString()}:${bucket}`,
        occurredAt: new Date(start).toISOString(),
        count: n,
      });
    });
}

// ---- analyst usage failures --------------------------------------------------------------------------

export interface UsageRow {
  id: number;
  status: string;
  createdAt: string;
}

export function eventFromAnalystUsage(row: UsageRow): NotificationEvent | null {
  if (row.status === 'ok') return null;
  return makeEvent({
    kind: 'analyst_call_failed',
    dedupeKey: `ai_usage:${row.id}`,
    occurredAt: row.createdAt,
  });
}

// ---- halts that ended --------------------------------------------------------------------------------

/** A halt that was active at the last look and is not any more (reset, or the UTC day changed). */
export function haltClearedEvents(
  accountId: number,
  before: readonly string[],
  now: readonly string[],
  at: Date,
): NotificationEvent[] {
  return before
    .filter((k) => !now.includes(k))
    .map((k) =>
      makeEvent({
        kind: 'halt_cleared',
        dedupeKey: `halt_cleared:${accountId}:${k}:${at.toISOString()}`,
        occurredAt: at.toISOString(),
        accountId,
      }),
    );
}
