import Link from 'next/link';
import type { Db } from '@/data/client';
import type { Account } from '@/data/accounts';
import { formatRemaining, getRiskSettingsView, syncRiskState } from '@/data/risk';
import { listRiskEvents } from '@/data/risk-events';
import {
  calculatePositionSize,
  HARD_CEILINGS,
  RISK_FIELDS,
  riskFieldLabel,
  type RiskField,
} from '@/domain/risk';
import { computeRiskUsage } from '@/domain/risk';
import { selectedAccount } from '../_lib/account';
import { formatMoney, formatUtc } from '../_lib/format';
import { guardedPage } from '../_lib/guard';
import { Help } from '../_lib/Help';
import { CountMeter, MetricTile, Signed, UsageMeter } from '../_lib/ui';
import { StepUpField } from '../_lib/StepUpField';
import { formatLocal } from '../_lib/form';
import { haltAction, resetAction, restoreDefaultsAction, updateSettingsAction } from './actions';

interface SearchParams {
  ok?: string;
  error?: string;
  direction?: string;
  entry?: string;
  stop?: string;
  target?: string;
  risk?: string;
  step?: string;
  min?: string;
  fee?: string;
}

const CEILING: Record<RiskField, string> = {
  maxRiskPerTradePercent: `max ${HARD_CEILINGS.maxRiskPerTradePercent}`,
  maxDailyLossPercent: `max ${HARD_CEILINGS.maxDailyLossPercent}`,
  maxOpenRiskPercent: `max ${HARD_CEILINGS.maxOpenRiskPercent}`,
  maxOpenTrades: `max ${HARD_CEILINGS.maxOpenTrades}`,
  maxDrawdownPercent: `max ${HARD_CEILINGS.maxDrawdownPercent}`,
  minRewardToRisk: `max ${HARD_CEILINGS.minRewardToRiskMax}`,
};

const blank = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : v.trim());

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<SearchParams> }) => {
    const sp = await searchParams;
    const { selected } = await selectedAccount(ctx);
    return (
      <main>
        <div className="page-head">
          <h1>Risk</h1>
          <p className="lead">
            Your safety rules, enforced by tested code. The engine has the final say: a plan that
            breaks a limit is refused with reasons.
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
        {!selected ? (
          <div className="empty">
            <h2>No account yet</h2>
            <p>
              <Link href="/accounts">Create a paper account</Link> first. Its risk limits start with
              default values.
            </p>
          </div>
        ) : (
          <AccountRisk
            sp={sp}
            account={selected}
            now={ctx.now}
            db={ctx.db}
            fresh={ctx.auth !== null}
          />
        )}
      </main>
    );
  },
);

function AccountRisk({
  sp,
  account,
  now,
  db,
  fresh,
}: {
  sp: SearchParams;
  account: Account;
  now: Date;
  db: Db;
  fresh: boolean;
}) {
  const accountId = account.id;
  const ctx = syncRiskState(db, accountId, now); // also records halts that were detected but not yet logged
  const view = getRiskSettingsView(db, accountId, now);
  const events = listRiskEvents(db, accountId, 50);
  const usage = computeRiskUsage(ctx);
  const base = account.baseCurrency;
  const manualHalted = ctx.halts.some((h) => h.kind === 'manual');

  const calc =
    sp.entry !== undefined || sp.stop !== undefined
      ? calculatePositionSize({
          equity: ctx.equity,
          riskPercent: blank(sp.risk) ?? view.effective?.maxRiskPerTradePercent ?? null,
          direction: sp.direction ?? 'long',
          entry: blank(sp.entry),
          stop: blank(sp.stop),
          target: blank(sp.target),
          sizeStep: blank(sp.step),
          minSize: blank(sp.min),
          feeRoundTripPercent: blank(sp.fee),
        })
      : null;

  return (
    <>
      <section aria-labelledby="status-title">
        <div className="section-head">
          <h2 id="status-title">Trading status</h2>
          <Help id="halts" />
        </div>
        {ctx.halts.length === 0 ? (
          <p className="notice notice-ok">
            No halt is active. New plans are checked against the limits below.
          </p>
        ) : (
          ctx.halts.map((h) => (
            <div key={h.kind} role="alert" className="halt-box">
              <p>
                <strong>HALTED ({h.kind.replace('_', ' ')})</strong>
              </p>
              <p>{h.message}</p>
              {h.since && <p>Began: {formatLocal(h.since)} (local time)</p>}
              {h.clearsAt && (
                <p>Clears by itself at {formatUtc(h.clearsAt)} (next UTC midnight).</p>
              )}
              {h.kind === 'drawdown' && (
                <p>
                  {h.resetAllowedNow ? (
                    <strong>The 24 hours have passed: the halt can be reset now.</strong>
                  ) : (
                    <>
                      <strong>Reset not possible yet.</strong> Time remaining:{' '}
                      <strong>{formatRemaining(h.resetRemainingMs ?? 0)}</strong> (available at{' '}
                      {formatUtc(h.resetAvailableAt)}). An earlier attempt is refused and logged.{' '}
                      <Help id="drawdownDetails" />
                    </>
                  )}
                </p>
              )}
              {(h.kind === 'manual' || h.kind === 'drawdown') && (
                <form action={resetAction}>
                  <input type="hidden" name="accountId" value={accountId} />
                  <input type="hidden" name="haltKind" value={h.kind} />
                  <div className="form-grid">
                    <div className="field">
                      <label htmlFor={`reset-confirm-${h.kind}`}>Type RESET</label>
                      <input id={`reset-confirm-${h.kind}`} name="confirm" autoComplete="off" />
                    </div>
                    <div className="field wide">
                      <label htmlFor={`reset-reason-${h.kind}`}>
                        Reason (at least 10 characters)
                      </label>
                      <input id={`reset-reason-${h.kind}`} name="reason" autoComplete="off" />
                    </div>
                  </div>
                  <StepUpField fresh={fresh} />
                  <p>
                    <button type="submit">Reset this halt</button>
                  </p>
                  {h.kind === 'drawdown' && (
                    <p className="small">
                      A reset makes the current equity the new baseline: the drawdown limit is
                      measured from there afterwards.
                    </p>
                  )}
                </form>
              )}
            </div>
          ))
        )}

        {!manualHalted && (
          <form action={haltAction} className="panel">
            <input type="hidden" name="accountId" value={accountId} />
            <div className="panel-title">
              <h3>Kill switch</h3>
            </div>
            <p className="small">
              Stops every new plan at once. One click, no code needed. A reset needs a typed word, a
              reason and a fresh authenticator code.
            </p>
            <div className="form-grid">
              <div className="field wide">
                <label htmlFor="halt-reason">Reason</label>
                <input id="halt-reason" name="reason" maxLength={500} autoComplete="off" />
              </div>
            </div>
            <button type="submit" className="danger">
              Halt trading now
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby="usage-title">
        <div className="section-head">
          <h2 id="usage-title">Limits in use</h2>
        </div>
        <div className="panel">
          <div className="meter-grid">
            <UsageMeter
              name="Daily loss"
              line={usage.dailyLoss}
              currency={base}
              help="haltHit"
              measuredAgainst="the equity at the start of the UTC day"
            />
            <UsageMeter
              name="Open risk"
              line={usage.openRisk}
              currency={base}
              help="ruleOpenRisk"
              measuredAgainst="current equity"
            />
            <CountMeter name="Open trades" usage={usage.openTrades} help="ruleOpenTrades" />
            <UsageMeter
              name="Drawdown"
              line={usage.drawdown}
              currency={base}
              help="drawdownDetails"
              measuredAgainst="the highest equity since the last baseline"
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="equity-title">
        <div className="section-head">
          <h2 id="equity-title">Equity and today</h2>
          <Help id="equity" />
        </div>
        {ctx.equity === null ? (
          <p role="alert" className="notice notice-alert">
            Equity cannot be verified, so every plan is refused: {ctx.equityProblem}
          </p>
        ) : (
          <div className="panel">
            <div className="grid grid-tight">
              <MetricTile label={`Current equity (${base})`} small>
                {formatMoney(ctx.equity)}
              </MetricTile>
              <MetricTile label={`Peak since the last baseline (${base})`} small>
                {ctx.peakEquity ? formatMoney(ctx.peakEquity) : 'n/a'}
              </MetricTile>
              <MetricTile label={`Fall from that peak (${base})`} small>
                {ctx.fallFromPeak ? formatMoney(ctx.fallFromPeak) : 'n/a'}
              </MetricTile>
              <MetricTile label={`Drawdown baseline (${base})`} small>
                {ctx.baselineEquity ? formatMoney(ctx.baselineEquity) : 'n/a'}
              </MetricTile>
              <MetricTile label={`Equity at the start of today (${base}, UTC)`} help="utcDay" small>
                {ctx.dayStartEquity
                  ? formatMoney(ctx.dayStartEquity)
                  : `n/a (${ctx.dayStartProblem})`}
              </MetricTile>
              <MetricTile label="Net result counted as today" small>
                <Signed value={ctx.todayNetPnl} currency={base} />
              </MetricTile>
              <MetricTile label="Open trades" small>
                {ctx.openTrades.length}
              </MetricTile>
            </div>
            <p className="small">
              UTC day started {formatUtc(ctx.dayStart)}. Unrealised results of open trades are not
              counted (no live prices).
            </p>
          </div>
        )}
        {ctx.tradesWithExcludedFees > 0 && (
          <p role="status" className="notice notice-note">
            {ctx.tradesWithExcludedFees} closed trade(s) had fees in another currency that were not
            deducted, so equity may be slightly too high.
          </p>
        )}
      </section>

      <section aria-labelledby="settings-title">
        <div className="section-head">
          <h2 id="settings-title">Limits</h2>
          <Help id="loosening" label="Tighter now, looser after 24 hours: what does this mean?" />
          <Help id="ceilings" label="Hard ceilings" />
        </div>
        {view.problem ? (
          <div role="alert" className="notice notice-alert">
            <p>The stored risk settings are damaged, so every plan is refused: {view.problem}</p>
            <form action={restoreDefaultsAction}>
              <input type="hidden" name="accountId" value={accountId} />
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="restore-confirm">Type RESET</label>
                  <input id="restore-confirm" name="confirm" autoComplete="off" />
                </div>
                <div className="field wide">
                  <label htmlFor="restore-reason">Reason</label>
                  <input id="restore-reason" name="reason" autoComplete="off" />
                </div>
              </div>
              <StepUpField fresh={fresh} />
              <button type="submit">Restore the default settings</button>
            </form>
          </div>
        ) : (
          <form action={updateSettingsAction} className="panel">
            <input type="hidden" name="accountId" value={accountId} />
            <p>
              Making a limit <strong>tighter</strong> applies immediately. Making it{' '}
              <strong>looser</strong> takes effect only after <strong>24 hours</strong> and needs a
              fresh authenticator code. Values above the hard ceilings are rejected.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Limit</th>
                    <th className="num">In force now</th>
                    <th>Pending (looser)</th>
                    <th>Hard ceiling</th>
                    <th>New value</th>
                  </tr>
                </thead>
                <tbody>
                  {RISK_FIELDS.map((f) => {
                    const pending = view.pending[f];
                    return (
                      <tr key={f}>
                        <th scope="row">
                          <label htmlFor={`set-${f}`}>{riskFieldLabel(f)}</label>
                        </th>
                        <td className="num">{String(view.effective?.[f])}</td>
                        <td>
                          {pending
                            ? `${pending.value} from ${pending.effectiveAt} (in ${formatRemaining(Math.max(0, new Date(pending.effectiveAt).getTime() - now.getTime()))})`
                            : 'none'}
                        </td>
                        <td>
                          {f === 'minRewardToRisk'
                            ? 'none (warning only), ' + CEILING[f]
                            : CEILING[f]}
                        </td>
                        <td>
                          <input
                            id={`set-${f}`}
                            name={f}
                            defaultValue={String(view.active?.[f])}
                            size={8}
                            inputMode="decimal"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <StepUpField fresh={fresh} />
            <p>
              <button type="submit">Save limits</button>
            </p>
          </form>
        )}
      </section>

      <section aria-labelledby="calc-title">
        <div className="section-head">
          <h2 id="calc-title">Position-size calculator</h2>
          <Help id="sizeCalculator" />
        </div>
        <form method="get" className="panel">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="calc-direction">Direction</label>
              <select id="calc-direction" name="direction" defaultValue={sp.direction ?? 'long'}>
                <option>long</option>
                <option>short</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="calc-entry">Entry</label>
              <input
                id="calc-entry"
                name="entry"
                defaultValue={sp.entry ?? ''}
                inputMode="decimal"
              />
            </div>
            <div className="field">
              <label htmlFor="calc-stop">Stop-loss</label>
              <input id="calc-stop" name="stop" defaultValue={sp.stop ?? ''} inputMode="decimal" />
            </div>
            <div className="field">
              <label htmlFor="calc-target">Target (optional)</label>
              <input
                id="calc-target"
                name="target"
                defaultValue={sp.target ?? ''}
                inputMode="decimal"
              />
            </div>
            <div className="field">
              <label htmlFor="calc-risk">Risk % (blank = your limit)</label>
              <input id="calc-risk" name="risk" defaultValue={sp.risk ?? ''} inputMode="decimal" />
            </div>
            <div className="field">
              <label htmlFor="calc-step">Size step</label>
              <input id="calc-step" name="step" defaultValue={sp.step ?? ''} inputMode="decimal" />
            </div>
            <div className="field">
              <label htmlFor="calc-min">Minimum size</label>
              <input id="calc-min" name="min" defaultValue={sp.min ?? ''} inputMode="decimal" />
            </div>
            <div className="field">
              <label htmlFor="calc-fee">Estimated fees % (round trip)</label>
              <input id="calc-fee" name="fee" defaultValue={sp.fee ?? ''} inputMode="decimal" />
            </div>
          </div>
          <button type="submit">Calculate</button>
        </form>
        {calc &&
          (calc.ok ? (
            <div className="table-wrap">
              <table>
                <tbody>
                  <tr>
                    <th scope="row">Size</th>
                    <td>
                      <strong>{calc.size}</strong>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Risk budget</th>
                    <td>{calc.riskBudget}</td>
                  </tr>
                  <tr>
                    <th scope="row">Money at risk if the stop is hit</th>
                    <td>{calc.riskAmount}</td>
                  </tr>
                  <tr>
                    <th scope="row">Estimated fees</th>
                    <td>{calc.estimatedFees}</td>
                  </tr>
                  <tr>
                    <th scope="row">Risk used (% of equity, rounded up)</th>
                    <td>{calc.riskPercentUsed}</td>
                  </tr>
                  <tr>
                    <th scope="row">Trade value (size × entry)</th>
                    <td>{calc.notional}</td>
                  </tr>
                  <tr>
                    <th scope="row">Reward-to-risk</th>
                    <td>{calc.rewardToRisk ?? 'no target given'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <div role="alert" className="notice notice-alert">
              <p>No size can be calculated:</p>
              <ul>
                {calc.problems.map((p) => (
                  <li key={p.code + p.message}>{p.message}</li>
                ))}
              </ul>
            </div>
          ))}
      </section>

      <section aria-labelledby="events-title">
        <div className="section-head">
          <h2 id="events-title">Recent risk events (newest first)</h2>
        </div>
        {events.length === 0 ? (
          <p className="small">No events yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Time (local)</th>
                  <th>Event</th>
                  <th>Halt</th>
                  <th>Trade</th>
                  <th>Reason</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>{e.id}</td>
                    <td>{formatLocal(e.createdAt)}</td>
                    <td>{e.kind}</td>
                    <td>{e.haltKind ?? ''}</td>
                    <td>
                      {e.tradeId ? <Link href={`/trades/${e.tradeId}`}>#{e.tradeId}</Link> : ''}
                    </td>
                    <td>{e.reason}</td>
                    <td>
                      <small>
                        {e.detailsJson.length > 160
                          ? e.detailsJson.slice(0, 160) + '…'
                          : e.detailsJson}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
