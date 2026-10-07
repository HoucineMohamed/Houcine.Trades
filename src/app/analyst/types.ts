import type { ReviewChecks } from '@/data/analyst';
import type { AnalystKind, AnalystOutput } from '@/domain/analyst';

/** What an analyst action sends back to a page (plain data, safe to pass to the browser). */
export type AnalystActionResult =
  | {
      ok: true;
      reviewId: number;
      kind: AnalystKind;
      output: AnalystOutput;
      checks: ReviewChecks;
      fromStore: boolean;
      createdAt: string;
    }
  | { ok: false; message: string };
