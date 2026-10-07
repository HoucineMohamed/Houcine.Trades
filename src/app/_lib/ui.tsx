import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Metric } from '@/domain/stats';
import type { CountUsage, UsageLine } from '@/domain/risk';
import { usageBar } from './chart';
import { formatMoney, formatMoneySigned, formatPercent, formatR, type SignedText } from './format';
import { Help } from './Help';
import type { HelpKey } from './help';

/**
 * Small display components. They show values the engines returned: a sign, a word and a number,
 * never a judgement. Profit and loss use a neutral colour pair AND a sign AND a word.
 */

function SignedSpan({ s, quiet = false }: { s: SignedText; quiet?: boolean }) {
  const cls =
    s.kind === 'profit' ? 'result-gain' : s.kind === 'loss' ? 'result-loss' : 'result-flat';
  return (
    <span className={cls}>
      {s.text}
      {!(quiet && s.kind === 'flat') && <span className="result-word">{s.word}</span>}
    </span>
  );
}

/** A result (net P&L, today's result) with sign, separators and a neutral word. */
/**
 * `quiet`: a zero is shown as a plain 0 without the word "break-even" (the word belongs to a
 * single trade's result, not to a sum that happens to be zero).
 */
export function Signed({
  value,
  currency,
  quiet = false,
}: {
  value: string;
  currency?: string;
  quiet?: boolean;
}) {
  return (
    <>
      <SignedSpan s={formatMoneySigned(value)} quiet={quiet} />
      {currency ? <> {currency}</> : null}
    </>
  );
}

export function SignedR({ value }: { value: string }) {
  return <SignedSpan s={formatR(value)} />;
}

/** "n/a" with the engine's reason when a number cannot be computed. */
export function NotAvailable({ reason }: { reason: string | null }) {
  return <span className="na">n/a{reason ? ` (${reason})` : ''}</span>;
}

/** An engine Metric as an amount, or n/a with its reason. */
export function MetricAmount({ metric, currency }: { metric: Metric; currency?: string }) {
  return metric.value === null ? (
    <NotAvailable reason={metric.reason} />
  ) : (
    <>
      {formatMoney(metric.value)}
      {currency ? <> {currency}</> : null}
    </>
  );
}

export function MetricSigned({ metric, currency }: { metric: Metric; currency?: string }) {
  return metric.value === null ? (
    <NotAvailable reason={metric.reason} />
  ) : (
    <Signed value={metric.value} currency={currency} />
  );
}

export function MetricR({ metric }: { metric: Metric }) {
  return metric.value === null ? (
    <NotAvailable reason={metric.reason} />
  ) : (
    <SignedR value={metric.value} />
  );
}

export function MetricPercent({ metric }: { metric: Metric }) {
  return metric.value === null ? (
    <NotAvailable reason={metric.reason} />
  ) : (
    <>{formatPercent(metric.value)}</>
  );
}

export function MetricPlain({ metric }: { metric: Metric }) {
  return metric.value === null ? <NotAvailable reason={metric.reason} /> : <>{metric.value}</>;
}

/** A labelled number with an optional "What does this mean?" explanation. */
export function MetricTile({
  label,
  help,
  sub,
  small,
  children,
}: {
  label: string;
  help?: HelpKey;
  sub?: ReactNode;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className={small ? 'metric-value sm' : 'metric-value'}>{children}</div>
      {sub ? <div className="metric-sub">{sub}</div> : null}
      {help ? <Help id={help} /> : null}
    </div>
  );
}

// ---- risk limit usage ------------------------------------------------------------------------------

function Bar({
  share,
  reached,
  label,
}: {
  share: string | null;
  reached: boolean | null;
  label: string;
}) {
  const bar = usageBar(share);
  const full = reached === true && !bar.known; // e.g. a limit of 0: reached, but no share to draw
  return (
    <svg
      className="usage-svg"
      viewBox="0 0 100 10"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <rect className="bar-track" x="0" y="0" width="100" height="10" />
      {(bar.known || full) && (
        <rect
          className={reached || bar.over ? 'bar-fill reached' : 'bar-fill'}
          x="0"
          y="0"
          width={full ? 100 : bar.fill}
          height="10"
        />
      )}
      <line className="bar-limit" x1="99.5" y1="0" x2="99.5" y2="10" />
    </svg>
  );
}

/** One money limit: how much is used, of which limit, from the risk engine's usage figures. */
export function UsageMeter({
  name,
  line,
  currency,
  help,
  measuredAgainst,
}: {
  name: string;
  line: UsageLine;
  currency: string | null;
  help?: HelpKey;
  measuredAgainst: string;
}) {
  const { used, limitAmount, usedPercent } = line;
  const unknown = used === null || limitAmount === null || usedPercent === null;
  const label = unknown
    ? `${name}: cannot be verified`
    : `${name}: ${line.shareOfLimit ?? '?'} % of the limit used`;
  return (
    <div className="usage">
      <div className="usage-head">
        <div className="usage-name">
          {name} {help ? <Help id={help} /> : null}
        </div>
        <span>
          {unknown ? (
            <span className="na">cannot be verified</span>
          ) : (
            <>
              {formatMoney(used)} of {formatMoney(limitAmount)}
              {currency ? ` ${currency}` : ''}
            </>
          )}
        </span>
      </div>
      <Bar share={line.shareOfLimit} reached={line.reached} label={label} />
      <div className="usage-foot">
        {unknown ? (
          (line.problem ?? 'The figures are incomplete, so they are not shown.')
        ) : (
          <>
            {formatPercent(usedPercent)} of {measuredAgainst}; the limit is {line.limitPercent} %.{' '}
            {line.reached ? (
              <strong>Limit reached.</strong>
            ) : (
              <>{line.shareOfLimit} % of the limit used.</>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function CountMeter({
  name,
  usage,
  help,
}: {
  name: string;
  usage: CountUsage;
  help?: HelpKey;
}) {
  return (
    <div className="usage">
      <div className="usage-head">
        <div className="usage-name">
          {name} {help ? <Help id={help} /> : null}
        </div>
        <span>
          {usage.used} of {usage.limit ?? '?'}
        </span>
      </div>
      <Bar
        share={usage.shareOfLimit}
        reached={usage.reached}
        label={`${name}: ${usage.used} of ${usage.limit ?? 'unknown'}`}
      />
      <div className="usage-foot">
        {usage.limit === null ? (
          'The limit cannot be read.'
        ) : usage.reached ? (
          <strong>Limit reached.</strong>
        ) : (
          'Below the limit.'
        )}
      </div>
    </div>
  );
}

export function TradeLink({ id, children }: { id: number; children?: ReactNode }) {
  return (
    <Link className="row-link" href={`/trades/${id}`}>
      {children ?? `#${id}`}
    </Link>
  );
}
