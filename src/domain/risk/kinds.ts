/** Kept in its own file with no imports so the database schema can use it. */
export const RISK_EVENT_KINDS = [
  'halt',
  'reset',
  'reset_refused',
  'plan_refused',
  'override',
  'settings_change',
  'settings_applied',
] as const;
export type RiskEventKind = (typeof RISK_EVENT_KINDS)[number];

export const HALT_KINDS = ['daily_loss', 'drawdown', 'manual'] as const;
export type HaltKind = (typeof HALT_KINDS)[number];

export const VERDICT_STAGES = ['created', 'opened'] as const;
export type VerdictStage = (typeof VERDICT_STAGES)[number];
