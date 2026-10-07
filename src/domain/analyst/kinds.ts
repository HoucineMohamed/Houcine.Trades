/** Kept with no imports so the database schema (loaded by drizzle-kit) can use it. */
export const ANALYST_KINDS = ['plan_review', 'weekly_review', 'tutor'] as const;
export type AnalystKind = (typeof ANALYST_KINDS)[number];

export const AI_USAGE_STATUSES = [
  'ok',
  'api_error',
  'timeout',
  'refused',
  'truncated',
  'invalid_output',
] as const;
export type AiUsageStatus = (typeof AI_USAGE_STATUSES)[number];

export const KIND_LABELS: Record<AnalystKind, string> = {
  plan_review: 'Plan review',
  weekly_review: 'Weekly review',
  tutor: 'Tutor',
};

/** The words shown next to every piece of analyst output. */
export const AI_COMMENTARY_LABEL = 'AI commentary, not advice; the risk engine decides';
