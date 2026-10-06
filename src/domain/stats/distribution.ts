import { Dec } from '../money/decimal';
import type { TradeResult } from './types';

/**
 * How the closed trades spread over net R (after fees), in buckets of 0.5 R from -3 to +3 with an
 * open bucket at each end. Counts only: no average, no judgement. Each bucket is
 * [lower, upper): a trade exactly on an edge belongs to the bucket that starts there.
 * Trades without a net R are counted separately (`unavailable`), never as zero.
 */

export const R_BUCKET_WIDTH = '0.5';
export const R_RANGE_MIN = -3;
export const R_RANGE_MAX = 3;

export interface RBucket {
  /** Inclusive lower edge in R, or null for the open "below" bucket. */
  lower: string | null;
  /** Exclusive upper edge in R, or null for the open "above" bucket. */
  upper: string | null;
  /** Plain label, e.g. "-3 to -2.5", "below -3", "3 and above". */
  label: string;
  count: number;
}

export interface RDistribution {
  buckets: RBucket[];
  /** Trades that have a net R (the sum of all bucket counts). */
  total: number;
  /** Trades whose net R is not available (not counted in any bucket). */
  unavailable: number;
}

const edgeText = (v: Dec) => v.toFixed();

export function computeRDistribution(results: readonly TradeResult[]): RDistribution {
  const width = new Dec(R_BUCKET_WIDTH);
  const edges: Dec[] = [];
  for (let e = new Dec(R_RANGE_MIN); e.lte(R_RANGE_MAX); e = e.plus(width)) edges.push(e);

  const buckets: RBucket[] = [
    {
      lower: null,
      upper: edgeText(edges[0] as Dec),
      label: `below ${edgeText(edges[0] as Dec)}`,
      count: 0,
    },
  ];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i] as Dec;
    const hi = edges[i + 1] as Dec;
    buckets.push({
      lower: edgeText(lo),
      upper: edgeText(hi),
      label: `${edgeText(lo)} to ${edgeText(hi)}`,
      count: 0,
    });
  }
  const top = edges[edges.length - 1] as Dec;
  buckets.push({
    lower: edgeText(top),
    upper: null,
    label: `${edgeText(top)} and above`,
    count: 0,
  });

  let total = 0;
  let unavailable = 0;
  for (const r of results) {
    const value = r.netR.value;
    if (value === null) {
      unavailable += 1;
      continue;
    }
    const v = new Dec(value);
    const bucket = buckets.find(
      (b) => (b.lower === null || v.gte(b.lower)) && (b.upper === null || v.lt(b.upper)),
    ) as RBucket; // the buckets cover every number
    bucket.count += 1;
    total += 1;
  }
  return { buckets, total, unavailable };
}
