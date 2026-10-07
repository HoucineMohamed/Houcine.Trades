import Link from 'next/link';
import type { EquityCurve, RDistribution } from '@/domain/stats';
import { equityGeometry, histogramGeometry, makeFrame } from './chart';
import { formatMoney, formatUtc } from './format';

/**
 * Hand-drawn SVG charts: classes and presentation attributes only (the Content-Security-Policy
 * forbids inline styles). Every chart has a text title, a description and a table of the same
 * values, so nothing depends on seeing colours or shapes.
 */

const dateOnly = (iso: string | undefined) => (iso ? formatUtc(iso).slice(0, 10) : '');

export function EquityChart({
  curve,
  currency,
  compact = false,
  id,
}: {
  curve: EquityCurve;
  currency: string;
  compact?: boolean;
  id: string;
}) {
  const width = compact ? 520 : 640;
  const height = compact ? 170 : 240;
  const frame = makeFrame(width, height, { left: 76, right: 16, top: 14, bottom: 26 });
  const g = equityGeometry(curve, frame);
  const first = curve.points[0];
  const last = curve.points[curve.points.length - 1];
  const title = `Equity curve in ${currency}`;
  const desc = curve.points.length
    ? `Equity after each of ${curve.points.length} closed trades, from ${formatMoney(curve.startingEquity)} to ${formatMoney(curve.endingEquity)} ${currency}. Highest point ${formatMoney(g.highLabel)}, lowest ${formatMoney(g.lowLabel)}.`
    : `No closed trades yet. Equity is ${formatMoney(curve.startingEquity)} ${currency}.`;
  return (
    <figure className="chart-figure" aria-labelledby={`${id}-t`}>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
      >
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{desc}</desc>
        <line
          className="chart-grid"
          x1={frame.left}
          x2={frame.right}
          y1={frame.top}
          y2={frame.top}
        />
        <line
          className="chart-axis"
          x1={frame.left}
          x2={frame.right}
          y1={frame.bottom}
          y2={frame.bottom}
        />
        <line className="chart-zero" x1={frame.left} x2={frame.right} y1={g.startY} y2={g.startY} />
        <text className="chart-text" x={frame.left - 8} y={frame.top + 4} textAnchor="end">
          {formatMoney(g.highLabel)}
        </text>
        <text className="chart-text" x={frame.left - 8} y={frame.bottom} textAnchor="end">
          {formatMoney(g.lowLabel)}
        </text>
        {g.hasDrawdown && <path className="chart-dd" d={g.drawdown} />}
        <path className="chart-line" d={g.line} />
        {g.dots.length <= 60 &&
          g.dots.map((d, i) => <circle key={i} className="chart-dot" cx={d.x} cy={d.y} r="3" />)}
        <text className="chart-text" x={frame.left} y={height - 6}>
          {first ? dateOnly(first.closedAt) : 'start'}
        </text>
        <text className="chart-text" x={frame.right} y={height - 6} textAnchor="end">
          {last ? dateOnly(last.closedAt) : ''}
        </text>
      </svg>
      <figcaption>
        <ul className="chart-legend">
          <li>
            <span className="swatch swatch-line" />
            Equity ({currency}); the dashed line is the starting equity
          </li>
          {g.hasDrawdown && (
            <li>
              <span className="swatch swatch-dd" />
              Shaded: the fall from the highest point so far
            </li>
          )}
        </ul>
      </figcaption>
      {!compact && curve.points.length > 0 && (
        <details className="data-table">
          <summary>Show the values as a table</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Closed (UTC)</th>
                  <th>Trade</th>
                  <th className="num">Equity</th>
                  <th className="num">Fall from the peak</th>
                </tr>
              </thead>
              <tbody>
                {curve.points.map((p) => (
                  <tr key={p.tradeId}>
                    <td>{formatUtc(p.closedAt)}</td>
                    <td>
                      <Link href={`/trades/${p.tradeId}`}>#{p.tradeId}</Link>
                    </td>
                    <td className="num">{formatMoney(p.equity)}</td>
                    <td className="num">{formatMoney(p.fallFromPeak)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

export function RHistogram({ distribution, id }: { distribution: RDistribution; id: string }) {
  const width = 640;
  const height = 200;
  const frame = makeFrame(width, height, { left: 16, right: 16, top: 20, bottom: 30 });
  const g = histogramGeometry(distribution.buckets, frame);
  const desc = distribution.total
    ? `How ${distribution.total} closed trades spread over net R, in buckets of 0.5 R.`
    : 'No closed trades with a net R yet.';
  return (
    <figure className="chart-figure" aria-labelledby={`${id}-t`}>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
      >
        <title id={`${id}-t`}>Distribution of R-multiples</title>
        <desc id={`${id}-d`}>{desc}</desc>
        <line
          className="chart-axis"
          x1={frame.left}
          x2={frame.right}
          y1={frame.bottom}
          y2={frame.bottom}
        />
        {g.bars.map((b) => (
          <g key={b.label}>
            <rect
              className={`chart-bar ${b.side}`}
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
            >
              <title>{`${b.label} R: ${b.count} trade${b.count === 1 ? '' : 's'}`}</title>
            </rect>
            {b.count > 0 && (
              <text className="chart-count" x={b.x + b.width / 2} y={b.y - 4}>
                {b.count}
              </text>
            )}
          </g>
        ))}
        {g.zeroX !== null && (
          <line className="chart-zero" x1={g.zeroX} x2={g.zeroX} y1={frame.top} y2={frame.bottom} />
        )}
        <text className="chart-text" x={frame.left} y={height - 8}>
          below −3 R
        </text>
        {g.zeroX !== null && (
          <text className="chart-text" x={g.zeroX} y={height - 8} textAnchor="middle">
            0 R
          </text>
        )}
        <text className="chart-text" x={frame.right} y={height - 8} textAnchor="end">
          3 R and above
        </text>
      </svg>
      <figcaption>
        <ul className="chart-legend">
          <li>
            Each bar counts trades in a 0.5 R bucket (net R, after fees). Bars left of the dashed
            line are below 0 R.
          </li>
          {distribution.unavailable > 0 && (
            <li>{distribution.unavailable} trade(s) have no net R and are not in any bar.</li>
          )}
        </ul>
      </figcaption>
      <details className="data-table">
        <summary>Show the counts as a table</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Net R bucket</th>
                <th className="num">Trades</th>
              </tr>
            </thead>
            <tbody>
              {distribution.buckets.map((b) => (
                <tr key={b.label}>
                  <td>{b.label}</td>
                  <td className="num">{b.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
