import type { NotificationEvent } from './events';
import type { EventKind, UsageKind } from './kinds';

/**
 * The text of a message. FIXED TEMPLATES: the only things that can vary are an event kind, a
 * level (50/80/100), a count and an account NUMBER (an integer). Nothing typed by the user (notes,
 * emotions, setup names, symbols, account names) and no amount, price, balance, key, token,
 * password, email or address can reach a message, because no such value is ever passed in.
 * Plain text only: no markup, no links, no buttons.
 */

const PREFIX = 'Houcine.Trades (paper): ';

const USAGE_LABELS: Record<UsageKind, string> = {
  daily_loss_usage: 'Daily loss limit',
  open_risk_usage: 'Open risk limit',
  open_trades_usage: 'Open trades limit',
  drawdown_usage: 'Drawdown limit',
  analyst_daily_calls_usage: 'Analyst daily call cap',
  analyst_monthly_calls_usage: 'Analyst monthly call cap',
  analyst_monthly_cost_usage: 'Analyst monthly cost cap (estimate)',
};

const FIXED: Partial<Record<EventKind, (acct: string, count: number) => string>> = {
  halt_started_daily_loss: (a) => `Trading is halted: the daily loss limit was reached${a}.`,
  halt_started_drawdown: (a) => `Trading is halted: the drawdown limit was reached${a}.`,
  halt_started_manual: (a) => `Trading was halted by hand${a}.`,
  halt_cleared: (a) => `A trading halt ended${a}.`,
  drawdown_reset_refused: (a) => `A reset of the drawdown halt was refused${a}.`,
  override_logged: (a) => `A refused plan was logged anyway (override)${a}.`,
  rule_violation_trade_logged: (a) => `A trade that breaks a risk rule was logged${a}.`,
  login_failures_burst: (_a, n) => `${n} failed sign-in attempts within 15 minutes.`,
  login_throttled: () => 'Sign-in attempts were slowed down after repeated failures.',
  login_success: () => 'A sign-in succeeded.',
  recovery_code_used: () => 'A recovery code was used to sign in.',
  password_changed: () => 'The password was changed.',
  security_settings_changed: () => 'A security setting was changed.',
  logout_everywhere: () => 'Every session was signed out.',
  step_up_failed: () => 'A fresh-code check failed.',
  analyst_call_failed: () => 'An analyst request failed.',
  notifications_switched_off: () => 'Alerts were switched off.',
  test_message: () => 'Test message. If you can read this, alerts reach you.',
  flood_summary: (_a, n) =>
    `${n} more events are waiting. Open the Notifications page to see them.`,
  backup_failed: () => 'A backup failed.',
  market_data_stale: () => 'Market data is out of date.',
};

const int = (v: number | null, fallback = 0): number =>
  v !== null && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : fallback;

export function messageFor(
  e: Pick<NotificationEvent, 'kind' | 'level' | 'count' | 'accountId'>,
): string {
  const acct =
    e.accountId !== null && Number.isInteger(e.accountId) && e.accountId > 0
      ? ` (account #${e.accountId})`
      : '';
  if (e.kind in USAGE_LABELS) {
    const label = USAGE_LABELS[e.kind as UsageKind];
    const isAnalyst = e.kind.startsWith('analyst_');
    const where = isAnalyst ? '' : acct;
    if (e.level === 100) return `${PREFIX}${label}: reached (100 % of the limit)${where}.`;
    const level = e.level === 50 || e.level === 80 ? e.level : 0;
    return `${PREFIX}${label}: ${level} % of the limit is used${where}.`;
  }
  const template = FIXED[e.kind];
  return template ? PREFIX + template(acct, int(e.count)) : `${PREFIX}An event happened.`;
}
