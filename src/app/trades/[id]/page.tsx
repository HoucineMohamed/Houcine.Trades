import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadTradeDetail, type VerdictView } from '@/data/journal-view';
import { tradeTimeline } from '@/domain/trades/timeline';
import { formatAmount, formatMoney, formatUtc, safeHttpUrl } from '../../_lib/format';
import { guardedPage } from '../../_lib/guard';
import { Help } from '../../_lib/Help';
import { StepUpField } from '../../_lib/StepUpField';
import { utcToLocalInput } from '../../_lib/form';
import { MetricAmount, MetricR, MetricTile, Signed } from '../../_lib/ui';
import { cancelTradeAction, closeTradeAction, openTradeAction } from '../actions';

const NUMBER_LABELS: [string, string][] = [
  ['equity', 'Equity'],
  ['riskAmount', 'Risk at the stop'],
  ['riskPercent', 'Risk, % of equity'],
  ['riskLimitAmount', 'Per-trade limit'],
  ['openRiskBefore', 'Open risk before'],
  ['openRiskAfter', 'Open risk after'],
  ['openRiskAfterPercent', 'Open risk after, % of equity'],
  ['openRiskLimitAmount', 'Open-risk limit'],
  ['openTradesAfter', 'Open trades after'],
  ['maxOpenTrades', 'Open-trades limit'],
  ['rewardToRisk', 'Reward-to-risk'],
];

const STAGE = {
  created: 'When the trade was logged',
  opened: 'When the trade was opened',
} as const;

function Verdict({ v }: { v: VerdictView }) {
  const numbers = NUMBER_LABELS.filter(([k]) => v.numbers && v.numbers[k] != null);
  return (
    <div className="verdict">
      <p>
        <strong>{STAGE[v.stage as keyof typeof STAGE] ?? v.stage}</strong> ({formatUtc(v.createdAt)}
        ): {v.approved ? 'the risk engine approved the plan.' : 'the risk engine refused the plan.'}
      </p>
      {v.overrideReason && (
        <p>
          <span className="badge badge-override">override</span> It was logged anyway. Reason given:{' '}
          <em>{v.overrideReason}</em>
        </p>
      )}
      {v.violations.length > 0 && (
        <ul>
          {v.violations.map((x) => (
            <li key={x.code + x.message}>
              <code>{x.code}</code> {x.message}
            </li>
          ))}
        </ul>
      )}
      {v.warnings.length > 0 && (
        <ul>
          {v.warnings.map((x) => (
            <li key={x.code}>
              Note <code>{x.code}</code>: {x.message}
            </li>
          ))}
        </ul>
      )}
      {numbers.length > 0 && (
        <dl className="facts">
          {numbers.map(([k, label]) => (
            <div key={k} className="contents">
              <dt>{label}</dt>
              <dd>{String(v.numbers?.[k])}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export default guardedPage(
  async (
    ctx,
    props: {
      params: Promise<{ id: string }>;
      searchParams: Promise<{ ok?: string; error?: string }>;
    },
  ) => {
    const { id: raw } = await props.params;
    const sp = await props.searchParams;
    const id = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
    const detail = Number.isNaN(id) ? null : loadTradeDetail(ctx.db, id);
    if (!detail) notFound();
    const { trade: t, account, result } = detail;
    const timeline = tradeTimeline(t);
    const fresh = ctx.auth !== null;
    const nowLocal = utcToLocalInput(ctx.now.toISOString());
    const link = safeHttpUrl(t.screenshotPath);
    const cur = t.quoteCurrency;

    return (
      <main>
        <div className="page-head">
          <h1>
            Trade #{t.id}: {t.symbol} {t.direction}
          </h1>
          <span className="tag status-trade">{t.status}</span>
          {detail.flags.overridden && <span className="badge badge-override">override</span>}
          <p className="lead">
            Account {account.name}
            {detail.setupName ? `, setup ${detail.setupName}` : ''}. Quoted in {cur}.{' '}
            <Link href="/trades">Back to the journal</Link>
          </p>
        </div>
        {sp.ok && (
          <p role="status" className="notice notice-ok">
            {sp.ok}
          </p>
        )}
        {sp.error && (
          <p role="alert" className="notice notice-alert">
            {sp.error}
          </p>
        )}

        <div className="grid grid-2">
          <section className="panel" aria-labelledby="timeline-title">
            <div className="panel-title">
              <h2 id="timeline-title">Life of the trade</h2>
            </div>
            <ol className="timeline">
              {timeline.map((s) => (
                <li key={s.key} className={s.done ? undefined : 'pending'}>
                  <strong>{s.label}</strong>
                  <span className="when">{s.done ? formatUtc(s.at) : 'not yet'}</span>
                  {s.note && <span className="when">{s.note}</span>}
                </li>
              ))}
            </ol>
          </section>

          <section className="panel" aria-labelledby="prices-title">
            <div className="panel-title">
              <h2 id="prices-title">Planned versus actual</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>&nbsp;</th>
                    <th className="num">Planned</th>
                    <th className="num">Actual</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Entry</th>
                    <td className="num">{formatAmount(t.plannedEntry)}</td>
                    <td className="num">{t.entryPrice ? formatAmount(t.entryPrice) : 'not yet'}</td>
                  </tr>
                  <tr>
                    <th scope="row">Stop-loss</th>
                    <td className="num">
                      {t.initialStopLoss
                        ? formatAmount(t.initialStopLoss)
                        : formatAmount(t.stopLoss)}
                    </td>
                    <td className="num">
                      {t.initialStopLoss && t.initialStopLoss !== t.stopLoss
                        ? `${formatAmount(t.stopLoss)} (moved)`
                        : t.initialStopLoss
                          ? 'unchanged'
                          : 'not yet'}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Take-profit</th>
                    <td className="num">{t.takeProfit ? formatAmount(t.takeProfit) : 'none'}</td>
                    <td className="num">
                      {t.exitPrice ? `exit ${formatAmount(t.exitPrice)}` : 'not yet'}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Size</th>
                    <td className="num" colSpan={2}>
                      {formatAmount(t.size)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Fees</th>
                    <td className="num" colSpan={2}>
                      {formatAmount(t.fees)} {t.feesCurrency}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="small">
              The initial stop is frozen when the trade opens; R is measured against it.{' '}
              <Help id="initialStop" />
            </p>
          </section>
        </div>

        {t.status === 'closed' && (
          <section aria-labelledby="result-title">
            <div className="section-head">
              <h2 id="result-title">Result</h2>
            </div>
            {result === null ? (
              <p className="notice notice-note">
                This closed trade could not be calculated
                {detail.skipped ? `: ${detail.skipped.reason}` : ''}. It is left out of the
                statistics and the equity.
              </p>
            ) : (
              <div className="panel">
                <div className="grid grid-tight">
                  <MetricTile label="Net result" help="netPnl" small>
                    <Signed value={result.netPnl} currency={cur} />
                  </MetricTile>
                  <MetricTile label="Gross result (before fees)" small>
                    <Signed value={result.grossPnl} currency={cur} />
                  </MetricTile>
                  <MetricTile label="Fees deducted" help="fees" small>
                    {formatMoney(result.feesApplied)} {cur}
                  </MetricTile>
                  <MetricTile label="Initial risk" help="initialRisk" small>
                    <MetricAmount metric={result.initialRisk} currency={cur} />
                  </MetricTile>
                  <MetricTile label="Net R" help="rMultiple" small>
                    <MetricR metric={result.netR} />
                  </MetricTile>
                  <MetricTile label="R before fees" small>
                    <MetricR metric={result.grossR} />
                  </MetricTile>
                </div>
                {result.feesExcluded && (
                  <p className="small">
                    The fees of this trade are in another currency than {cur}, so they were not
                    deducted and are not converted.
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        <section aria-labelledby="risk-title">
          <div className="section-head">
            <h2 id="risk-title">What the risk engine said</h2>
            <Help id="overrides" />
          </div>
          <div className="panel">
            {detail.verdicts.length === 0 ? (
              <p className="small">
                No risk verdict was stored for this trade (it was logged before the risk engine
                existed).
              </p>
            ) : (
              detail.verdicts.map((v) => <Verdict key={v.id} v={v} />)
            )}
          </div>
        </section>

        <section aria-labelledby="notes-title">
          <div className="section-head">
            <h2 id="notes-title">Notes</h2>
            {t.status !== 'cancelled' && <Link href={`/trades/${t.id}/edit`}>Edit</Link>}
          </div>
          <div className="panel stack">
            <div>
              <div className="metric-label">Plan notes</div>
              <p className="notes">{t.planNotes || 'none'}</p>
            </div>
            <div>
              <div className="metric-label">Review notes</div>
              <p className="notes">{t.reviewNotes || 'none'}</p>
            </div>
            <div>
              <div className="metric-label">Emotion</div>
              <p className="notes">{t.emotion || 'none'}</p>
            </div>
            <div>
              <div className="metric-label">Screenshot</div>
              <p className="notes">
                {t.screenshotPath === null ? (
                  'none'
                ) : link ? (
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    {link}
                  </a>
                ) : (
                  <>
                    {t.screenshotPath}{' '}
                    <span className="small">
                      (shown as text: only http and https links become links)
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>
        </section>

        {t.status === 'planned' && (
          <section aria-labelledby="open-title">
            <div className="section-head">
              <h2 id="open-title">Open this trade</h2>
            </div>
            <form action={openTradeAction} className="panel">
              <input type="hidden" name="id" value={t.id} />
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="o-entry">Entry price (what you really got)</label>
                  <input
                    id="o-entry"
                    name="entryPrice"
                    required
                    inputMode="decimal"
                    defaultValue={t.plannedEntry}
                  />
                </div>
                <div className="field">
                  <label htmlFor="o-at">Opened at (your local time)</label>
                  <input
                    id="o-at"
                    name="openedAt"
                    type="datetime-local"
                    required
                    defaultValue={nowLocal}
                  />
                </div>
              </div>
              <p className="small">
                The risk engine checks the real entry price. If it refuses, you can still log the
                trade by typing OVERRIDE and a reason; it is flagged forever and needs a fresh
                authenticator code.
              </p>
              <details>
                <summary>Override fields (leave empty unless the plan was refused)</summary>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="o-confirm">Type OVERRIDE</label>
                    <input id="o-confirm" name="overrideConfirm" autoComplete="off" />
                  </div>
                  <div className="field wide">
                    <label htmlFor="o-reason">Reason (at least 10 characters)</label>
                    <input id="o-reason" name="overrideReason" maxLength={500} autoComplete="off" />
                  </div>
                </div>
                <StepUpField fresh={fresh} />
              </details>
              <p>
                <button type="submit">Mark as open</button>
              </p>
            </form>
            <form action={cancelTradeAction} className="actions-row">
              <input type="hidden" name="id" value={t.id} />
              <button type="submit" className="secondary">
                Cancel this planned trade
              </button>
              <span className="small">A cancelled trade is locked.</span>
            </form>
          </section>
        )}

        {t.status === 'open' && (
          <section aria-labelledby="close-title">
            <div className="section-head">
              <h2 id="close-title">Close this trade</h2>
            </div>
            <form action={closeTradeAction} className="panel">
              <input type="hidden" name="id" value={t.id} />
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="c-exit">Exit price</label>
                  <input id="c-exit" name="exitPrice" required inputMode="decimal" />
                </div>
                <div className="field">
                  <label htmlFor="c-at">Closed at (your local time)</label>
                  <input
                    id="c-at"
                    name="closedAt"
                    type="datetime-local"
                    required
                    defaultValue={nowLocal}
                  />
                </div>
                <div className="field">
                  <label htmlFor="c-fees">Fees (optional)</label>
                  <input id="c-fees" name="fees" inputMode="decimal" />
                  <span className="field-hint">in {t.feesCurrency}</span>
                </div>
                <div className="field">
                  <label htmlFor="c-emotion">Emotion (optional)</label>
                  <input id="c-emotion" name="emotion" maxLength={200} />
                </div>
                <div className="field wide">
                  <label htmlFor="c-review">Review notes (optional)</label>
                  <textarea id="c-review" name="reviewNotes" rows={3} maxLength={5000} />
                </div>
              </div>
              <p className="small">Closing is never blocked by risk rules: it only reduces risk.</p>
              <p>
                <button type="submit">Close trade</button>
              </p>
            </form>
          </section>
        )}
      </main>
    );
  },
);
