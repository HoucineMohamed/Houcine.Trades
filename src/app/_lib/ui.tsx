import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Metric } from '@/domain/stats';
import type { CountUsage, UsageLine } from '@/domain/risk';
import { usageBar } from './chart';
import { formatAmount, formatPercent, formatR, formatSigned, type SignedText } from './format';
import { Help } from './Help';
import type { HelpKey } from './help';

/**
 * Small display components. They show values the engines returned: a sign, a word and a number,
 * never a judgement. Profit and loss use a neutral colour pair AND a sign AND a word.
 */

function SignedSpan({ s }: { s: SignedText }) {
  const cls =
    s.kind === 'profit' ? 'result-gain' : s.kind === 'loss' ? 'result-loss' : 'result-flat';
  return (
    <span className={cls}>
      {s.text}
      <span className="result-word">{s.word}</span>
    </span>
  );
}

/** A result (net P&L, today's result) with sign, separators and a neutral word. */
export function Signed({
  value,
  currency,
  places,
}: {
  value: string;
  currency?: string;
  places?: number;
}) {
  return (
    <>
      <SignedSpan s={formatSigned(value, places)} />
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
      {formatAmount(metric.value)}
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
      <div className="metric-label">
        <span>{label}</span>
        {help ? <Help id={help} /> : null}
      </div>
      <div className={small ? 'metric-value sm' : 'metric-value'}>{children}</div>
      {sub ? <div className="metric-sub">{sub}</div> : null}
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
  return (
    <svg
      className="usage-svg"
      viewBox="0 0 100 10"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <rect className="bar-track" x="0" y="0" width="100" height="10" />
      {bar.known && (
        <rect
          className={reached || bar.over ? 'bar-fill reached' : 'bar-fill'}
          x="0"
          y="0"
          width={bar.fill}
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
  const unknown = line.used === null;
  const label = unknown
    ? `${name}: cannot be verified`
    : `${name}: ${line.shareOfLimit ?? '?'} % of the limit used`;
  return (
    <div className="usage">
      <div className="usage-head">
        <span className="usage-name">
          {name} {help ? <Help id={help} /> : null}
        </span>
        <span>
          {unknown ? (
            <span className="na">cannot be verified</span>
          ) : (
            <>
              {formatAmount(line.used as string)} of {formatAmount(line.limitAmount as string)}
              {currency ? ` ${currency}` : ''}
            </>
          )}
        </span>
      </div>
      <Bar share={line.shareOfLimit} reached={line.reached} label={label} />
      <div className="usage-foot">
        {unknown ? (
          line.problem
        ) : (
          <>
            {formatPercent(line.usedPercent as string)} of {measuredAgainst}; the limit is{' '}
            {line.limitPercent} %.{' '}
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
        <span className="usage-name">
          {name} {help ? <Help id={help} /> : null}
        </span>
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
