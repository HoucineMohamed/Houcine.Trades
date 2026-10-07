import type { RiskContext } from '@/domain/risk';

/** The risk state in a few plain words for the header. Only maps what the engine returned. */
export interface RiskStatus {
  tone: 'halted' | 'unverified' | 'clear';
  label: string;
  /** One line with the reason(s), for people using a screen reader or hovering. */
  detail: string;
}

const HALT_WORDS: Record<string, string> = {
  manual: 'manual halt',
  drawdown: 'drawdown halt',
  daily_loss: 'daily-loss halt',
};

export function riskStatus(ctx: RiskContext): RiskStatus {
  if (ctx.halts.length > 0) {
    const words = ctx.halts.map((h) => HALT_WORDS[h.kind] ?? h.kind);
    return {
      tone: 'halted',
      label: `HALTED: ${words.join(', ')}`,
      detail: `Every new plan is refused while a halt is active (${words.join(', ')}).`,
    };
  }
  if (ctx.settings === null || ctx.equity === null) {
    const why = ctx.settings === null ? ctx.settingsProblem : ctx.equityProblem;
    return {
      tone: 'unverified',
      label: 'Risk cannot be verified',
      detail: `Plans are refused until this is fixed: ${why ?? 'unknown problem'}`,
    };
  }
  return { tone: 'clear', label: 'No halt active', detail: 'No halt is active right now.' };
}
