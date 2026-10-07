import { z } from 'zod';
import type { AnalystKind } from './kinds';

/**
 * What comes back from the AI is checked here before anything is shown or stored:
 *  1. it must be ONE JSON object of exactly the expected shape (zod, strict);
 *  2. every cited figure must equal a value that was in the input (exact text match), else it is
 *     shown as "unverified" and the review is flagged;
 *  3. a rough word check looks for trade-instruction wording (shows a neutral warning, keeps the text).
 * Text is only ever shown as escaped plain text.
 */

// Control characters except newline and tab are removed; nothing else is changed.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.replace(CONTROL, '').trim());
const list = (maxItems: number, maxLen: number) => z.array(text(maxLen)).max(maxItems);

const citedFigure = z.strictObject({ label: text(160), value: text(60) });
const cited = z.array(citedFigure).max(40);

const SCHEMAS = {
  plan_review: z.strictObject({
    explanation: text(3000),
    questions: list(8, 500),
    conflicts: list(8, 600),
    cited_figures: cited,
  }),
  weekly_review: z.strictObject({
    summary: text(2000),
    patterns: list(10, 700),
    mistakes: list(10, 700),
    rule_breaking: list(10, 700),
    data_limits: list(8, 600),
    questions: list(8, 500),
    cited_figures: cited,
  }),
  tutor: z.strictObject({
    explanation: text(3500),
    example: text(2000),
    key_points: list(8, 400),
    cited_figures: cited,
  }),
} as const;

export type PlanReviewOutput = z.infer<(typeof SCHEMAS)['plan_review']>;
export type WeeklyReviewOutput = z.infer<(typeof SCHEMAS)['weekly_review']>;
export type TutorOutput = z.infer<(typeof SCHEMAS)['tutor']>;
export type AnalystOutput = PlanReviewOutput | WeeklyReviewOutput | TutorOutput;
export interface CitedFigure {
  label: string;
  value: string;
}

export type ParsedOutput = { ok: true; output: AnalystOutput } | { ok: false; problem: string };

/** Parses the model's reply text. Never throws; a bad reply is a plain problem message. */
export function parseAnalystOutput(kind: AnalystKind, reply: string): ParsedOutput {
  let value: unknown;
  try {
    value = JSON.parse(reply.trim());
  } catch {
    return { ok: false, problem: 'the reply was not valid JSON' };
  }
  const result = SCHEMAS[kind].safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      problem: `the reply did not have the expected shape (${result.error.issues
        .slice(0, 3)
        .map((i) => i.path.join('.') || 'root')
        .join(', ')})`,
    };
  }
  return { ok: true, output: result.data };
}

/** Re-validates a stored output (rows are checked again whenever they are read). */
export const parseStoredOutput = (kind: AnalystKind, json: string) =>
  parseAnalystOutput(kind, json);

// ---- figure verification ----------------------------------------------------------------------

export interface FigureCheck {
  verified: CitedFigure[];
  unverified: CitedFigure[];
}

/** A cited figure is verified only when its text equals a value that was in the input. */
export function verifyFigures(cited: CitedFigure[], allowed: readonly string[]): FigureCheck {
  const set = new Set(allowed);
  const verified: CitedFigure[] = [];
  const unverified: CitedFigure[] = [];
  for (const c of cited) (set.has(c.value) ? verified : unverified).push(c);
  return { verified, unverified };
}

// ---- trade-instruction wording ----------------------------------------------------------------

const ACTIONS =
  'buy|sell|short|close|exit|open|enter|add to|cut|reduce|increase|raise|double|widen|move';
const PATTERNS: RegExp[] = [
  // "you should close", "I recommend buying", "consider selling", "go ahead and ..."
  new RegExp(
    `\\b(?:you\\s+(?:should|must|need\\s+to|ought\\s+to|could\\s+also)|i\\s+(?:recommend|suggest|advise)|consider|try\\s+to|go\\s+ahead\\s+and|it\\s+is\\s+time\\s+to|time\\s+to)\\s+(?:\\w+\\s+){0,2}?(?:${ACTIONS})`,
    'i',
  ),
  // "buy now", "sell more", "close the trade", "exit your position"
  /\b(?:buy|sell|close|exit|cut|add\s+to)\s+(?:now|more|half|the\s+(?:trade|position)|this\s+(?:trade|position)|your\s+(?:trade|position))\b/i,
  // "increase your position size", "double the size", "size up", "use more leverage"
  /\b(?:increase|raise|double|scale\s+up|size\s+up)\s+(?:your\s+|the\s+)?(?:position|size|risk|stake|leverage)/i,
  /\bsize\s+up\b/i,
  // "ignore the limit", "bypass the verdict", "override the halt", "go above your limit"
  /\b(?:ignore|bypass|skip|disregard|work\s+around|exceed|loosen)\s+(?:the\s+|your\s+|this\s+)?(?:risk\s+)?(?:limits?|stop(?:-loss)?|rules?|halt|verdict|engine)/i,
  /\boverride\s+(?:the\s+|your\s+)?(?:limit|halt|verdict|refusal|risk\s+engine)/i,
  /\bmove\s+(?:your|the)\s+stop/i,
  /\btake\s+profit\s+(?:now|here)\b/i,
];

/** The values of every text field of an output (for scanning). */
export function outputTexts(output: AnalystOutput): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(output)) {
    if (key === 'cited_figures') continue;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') out.push(v);
  }
  return out;
}

/** Sentences that look like a trade instruction. A rough check: it warns, it does not delete. */
export function findInstructionWording(texts: readonly string[]): string[] {
  const hits: string[] = [];
  for (const t of texts) {
    for (const sentence of t.split(/(?<=[.!?\n])\s+/)) {
      if (PATTERNS.some((p) => p.test(sentence))) hits.push(sentence.trim().slice(0, 200));
    }
  }
  return hits;
}

export interface OutputChecks {
  figures: FigureCheck;
  instructionHits: string[];
  /** True when the review should carry a flag: an unverified figure or instruction-like wording. */
  flagged: boolean;
}

export function checkOutput(
  output: AnalystOutput,
  allowedFigures: readonly string[],
): OutputChecks {
  const figures = verifyFigures(output.cited_figures, allowedFigures);
  const instructionHits = findInstructionWording(outputTexts(output));
  return {
    figures,
    instructionHits,
    flagged: figures.unverified.length > 0 || instructionHits.length > 0,
  };
}
