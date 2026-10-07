import { Dec } from '@/domain/money/decimal';
import type { EquityCurve, RBucket } from '@/domain/stats';

/**
 * Chart geometry for hand-drawn SVG. This turns numbers that the engines already produced into
 * pixel positions, and nothing else: no money is added, no statistic is computed. Axis labels are
 * the engine's own exact text (the peak and the lowest equity), never values derived from the
 * pixels. Positions are plain floats, which is fine for drawing and is never shown as an amount.
 */

const r2 = (v: number) => Math.round(v * 100) / 100;
const pt = (x: number, y: number) => `${r2(x)} ${r2(y)}`;

export interface Frame {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function makeFrame(width: number, height: number, margin = {}): Frame {
  const m = { left: 12, right: 12, top: 12, bottom: 28, ...margin };
  return {
    width,
    height,
    left: m.left,
    right: width - m.right,
    top: m.top,
    bottom: height - m.bottom,
  };
}

/** Maps a value in [d0, d1] to [r0, r1]. A flat domain maps to the middle. */
export function scaleLinear(d0: number, d1: number, r0: number, r1: number) {
  return (v: number) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));
}

// ---- equity curve with the fall from the peak ------------------------------------------------------

export interface EquityGeometry {
  frame: Frame;
  /** Polyline path of the equity. */
  line: string;
  /** Closed shape between the running peak and the equity (empty when equity never fell). */
  drawdown: string;
  /** y of the starting equity, drawn as a reference line. */
  startY: number;
  /** Exact engine text for the top and bottom of the scale. */
  highLabel: string;
  lowLabel: string;
  /** One point per curve point (after each closed trade), with its position. */
  dots: { x: number; y: number; tradeId: number | null }[];
  hasDrawdown: boolean;
}

/** Pairs of Dec comparison helpers on engine text. */
const lower = (a: string, b: string) => (new Dec(a).lte(b) ? a : b);
const higher = (a: string, b: string) => (new Dec(a).gte(b) ? a : b);

const finite = (text: string) => {
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
};

export function equityGeometry(curve: EquityCurve, frame: Frame): EquityGeometry {
  const equities = [curve.startingEquity, ...curve.points.map((p) => p.equity)];
  const peaks = [curve.startingEquity, ...curve.points.map((p) => p.peak)];
  const ids: (number | null)[] = [null, ...curve.points.map((p) => p.tradeId)];

  let lowLabel = equities[0] as string;
  let highLabel = peaks[0] as string;
  for (const e of equities) lowLabel = lower(lowLabel, e);
  for (const p of peaks) highLabel = higher(highLabel, p);

  const y = scaleLinear(finite(lowLabel), finite(highLabel), frame.bottom, frame.top);
  const n = equities.length - 1;
  const x = (i: number) =>
    n === 0 ? (frame.left + frame.right) / 2 : frame.left + (i / n) * (frame.right - frame.left);

  const eq = equities.map((e, i) => ({ x: x(i), y: y(finite(e)) }));
  const pk = peaks.map((p, i) => ({ x: x(i), y: y(finite(p)) }));
  const line = eq.map((p, i) => `${i === 0 ? 'M' : 'L'} ${pt(p.x, p.y)}`).join(' ');

  const hasDrawdown = curve.points.some((p) => !new Dec(p.fallFromPeak).isZero());
  const drawdown = hasDrawdown
    ? `${pk.map((p, i) => `${i === 0 ? 'M' : 'L'} ${pt(p.x, p.y)}`).join(' ')} ${[...eq]
        .reverse()
        .map((p) => `L ${pt(p.x, p.y)}`)
        .join(' ')} Z`
    : '';

  return {
    frame,
    line,
    drawdown,
    startY: r2(y(finite(curve.startingEquity))),
    highLabel,
    lowLabel,
    dots: eq.map((p, i) => ({ x: r2(p.x), y: r2(p.y), tradeId: ids[i] ?? null })),
    hasDrawdown,
  };
}

// ---- R distribution --------------------------------------------------------------------------------

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  count: number;
  /** Which side of 0 R the bucket lies on (for a neutral colour pair, never a verdict). */
  side: 'below' | 'above';
}

export interface HistogramGeometry {
  frame: Frame;
  bars: Bar[];
  maxCount: number;
  /** x of the 0 R boundary, or null when there is no such edge. */
  zeroX: number | null;
}

export function histogramGeometry(buckets: readonly RBucket[], frame: Frame): HistogramGeometry {
  const maxCount = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const slot = (frame.right - frame.left) / Math.max(1, buckets.length);
  const gap = Math.min(4, slot * 0.2);
  const y = scaleLinear(0, maxCount, frame.bottom, frame.top);
  const bars: Bar[] = buckets.map((b, i) => {
    const top = b.count === 0 ? frame.bottom : y(b.count);
    return {
      x: r2(frame.left + i * slot + gap / 2),
      y: r2(top),
      width: r2(Math.max(0, slot - gap)),
      height: r2(frame.bottom - top),
      label: b.label,
      count: b.count,
      side: b.upper !== null && new Dec(b.upper).lte(0) ? 'below' : 'above',
    };
  });
  const zeroIndex = buckets.findIndex((b) => b.lower === '0');
  return {
    frame,
    bars,
    maxCount,
    zeroX: zeroIndex < 0 ? null : r2(frame.left + zeroIndex * slot),
  };
}

// ---- usage bars ------------------------------------------------------------------------------------

export interface UsageBar {
  /** 0 to 100: how much of the bar is filled. */
  fill: number;
  /** The share of the limit is above 100 %. */
  over: boolean;
  known: boolean;
}

/** `shareOfLimit` is the engine's text ("50.00"); null means it could not be verified. */
export function usageBar(shareOfLimit: string | null): UsageBar {
  if (shareOfLimit === null || !/^\d+(\.\d+)?$/.test(shareOfLimit)) {
    return { fill: 0, over: false, known: false };
  }
  const n = Number(shareOfLimit);
  if (!Number.isFinite(n)) return { fill: 0, over: false, known: false };
  return { fill: r2(Math.min(100, n)), over: n > 100, known: true };
}
