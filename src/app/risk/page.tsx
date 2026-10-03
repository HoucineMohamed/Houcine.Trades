import { listAccounts } from '@/data/accounts';
import { formatRemaining, getRiskSettingsView, syncRiskState } from '@/data/risk';
import { listRiskEvents } from '@/data/risk-events';
import {
  calculatePositionSize,
  HARD_CEILINGS,
  RISK_FIELDS,
  riskFieldLabel,
  type RiskField,
} from '@/domain/risk';
import { requireDb } from '../_lib/db';
import { formatLocal, toId } from '../_lib/form';
import { haltAction, resetAction, restoreDefaultsAction, updateSettingsAction } from './actions';

interface SearchParams {
  account?: string;
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

export default async function RiskPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const db = await requireDb();
  const accounts = listAccounts(db);
  const account = accounts.find((a) => a.id === (toId(sp.account) ?? accounts[0]?.id));
  const now = new Date();

  return (
    <main>
      <h1>Risk</h1>
      <p>
        Your safety rules, enforced by tested code. The engine has the final say: a plan that breaks
        a limit is refused with reasons. Every rule is explained in <code>docs/risk-rules.md</code>.
      </p>
      {sp.ok && <p role="status">✅ {sp.ok}</p>}
      {sp.error && <p role="alert">❌ {sp.error}</p>}

      {accounts.length === 0 || !account ? (
        <p>No account yet. Create one in Accounts first.</p>
      ) : (
        <AccountRisk sp={sp} accounts={accounts} accountId={account.id} now={now} db={db} />
      )}
    </main>
  );
}

function AccountRisk({
  sp,
  accounts,
  accountId,
  now,
  db,
}: {
  sp: SearchParams;
  accounts: ReturnType<typeof listAccounts>;
  accountId: number;
  now: Date;
  db: Awaited<ReturnType<typeof requireDb>>;
}) {
  const ctx = syncRiskState(db, accountId, now); // also records halts that were detected but not yet logged
  const view = getRiskSettingsView(db, accountId, now);
  const events = listRiskEvents(db, accountId, 50);
  const account = accounts.find((a) => a.id === accountId)!;
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
      <form method="get">
        <label>
          Account{' '}
          <select name="account" defaultValue={String(accountId)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.baseCurrency})
              </option>
            ))}
          </select>
        </label>{' '}
        <button type="submit">Show</button>
      </form>

      <h2>Trading status</h2>
      {ctx.halts.length === 0 ? (
        <p>✅ Trading is NOT halted.</p>
      ) : (
        ctx.halts.map((h) => (
          <div
            key={h.kind}
            role="alert"
            style={{ border: '2px solid #c33', padding: '0.5rem 1rem', margin: '0.5rem 0' }}
          >
            <p>
              <strong>🛑 HALTED ({h.kind.replace('_', ' ')})</strong>
            </p>
            <p>{h.message}</p>
            {h.since && <p>Began: {formatLocal(h.since)} (local time)</p>}
            {h.clearsAt && <p>Clears by itself at {h.clearsAt} (next UTC midnight).</p>}
            {h.kind === 'drawdown' && (
              <p>
                {h.resetAllowedNow ? (
                  <strong>The 24 hours have passed: you can reset it now.</strong>
                ) : (
                  <>
                    <strong>Reset not possible yet.</strong> Time remaining:{' '}
                    <strong>{formatRemaining(h.resetRemainingMs ?? 0)}</strong> (available at{' '}
                    {h.resetAvailableAt}). Trying earlier is refused and logged.
                  </>
                )}
              </p>
            )}
            {(h.kind === 'manual' || h.kind === 'drawdown') && (
              <form action={resetAction}>
                <input type="hidden" name="accountId" value={accountId} />
                <input type="hidden" name="haltKind" value={h.kind} />
                <p>
                  <label>
                    Type RESET <input name="confirm" autoComplete="off" />
                  </label>{' '}
                  <label>
                    Reason (at least 10 characters){' '}
                    <input name="reason" size={50} autoComplete="off" />
                  </label>{' '}
                  <button type="submit">Reset this halt</button>
                </p>
                {h.kind === 'drawdown' && (
                  <p>
                    <small>
                      A reset makes your current equity the new baseline: the drawdown limit is
                      measured from there afterwards.
                    </small>
                  </p>
                )}
              </form>
            )}
          </div>
        ))
      )}

      {!manualHalted && (
        <form action={haltAction}>
          <input type="hidden" name="accountId" value={accountId} />
          <p>
            <strong>Kill switch:</strong>{' '}
            <label>
              Reason <input name="reason" size={40} maxLength={500} autoComplete="off" />
            </label>{' '}
            <button type="submit">HALT TRADING NOW</button>
          </p>
        </form>
      )}

      <h2>Equity and today</h2>
      {ctx.equity === null ? (
        <p role="alert">
          ❌ Equity cannot be verified, so every plan is refused: {ctx.equityProblem}
        </p>
      ) : (
        <table border={1} cellPadding={6}>
          <tbody>
            <tr>
              <th align="left">Current equity ({account.baseCurrency})</th>
              <td>{ctx.equity}</td>
            </tr>
            <tr>
              <th align="left">Peak equity since the last baseline</th>
              <td>{ctx.peakEquity}</td>
            </tr>
            <tr>
              <th align="left">Fall from that peak</th>
              <td>{ctx.fallFromPeak}</td>
            </tr>
            <tr>
              <th align="left">Drawdown baseline</th>
              <td>{ctx.baselineEquity}</td>
            </tr>
            <tr>
              <th align="left">Equity at the start of today (UTC)</th>
              <td>{ctx.dayStartEquity ?? `n/a (${ctx.dayStartProblem})`}</td>
            </tr>
            <tr>
              <th align="left">Net realised P&amp;L counted as today</th>
              <td>{ctx.todayNetPnl}</td>
            </tr>
            <tr>
              <th align="left">UTC day started</th>
              <td>{ctx.dayStart}</td>
            </tr>
            <tr>
              <th align="left">Open trades</th>
              <td>{ctx.openTrades.length}</td>
            </tr>
          </tbody>
        </table>
      )}
      <p>
        <small>
          Equity = starting balance + net realised P&amp;L (from the stats engine). Unrealised
          P&amp;L of open trades is NOT counted (no live prices yet). The day boundary is UTC
          midnight. A closed trade counts as today if its closed time OR the time it was recorded as
          closed is today.
        </small>
      </p>
      {ctx.tradesWithExcludedFees > 0 && (
        <p role="status">
          ⚠️ {ctx.tradesWithExcludedFees} closed trade(s) had fees in another currency that were not
          deducted, so equity may be slightly too high.
        </p>
      )}

      <h2>Settings</h2>
      {view.problem ? (
        <div role="alert">
          <p>❌ The stored risk settings are damaged, so every plan is refused: {view.problem}</p>
          <form action={restoreDefaultsAction}>
            <input type="hidden" name="accountId" value={accountId} />
            <p>
              <label>
                Type RESET <input name="confirm" autoComplete="off" />
              </label>{' '}
              <label>
                Reason <input name="reason" size={50} autoComplete="off" />
              </label>{' '}
              <button type="submit">Restore the default settings</button>
            </p>
          </form>
        </div>
      ) : (
        <>
          <p>
            Making a limit <strong>tighter</strong> applies immediately. Making it{' '}
            <strong>looser</strong> takes effect only after <strong>24 hours</strong>. Values above
            the hard ceilings are rejected.
          </p>
          <form action={updateSettingsAction}>
            <input type="hidden" name="accountId" value={accountId} />
            <table border={1} cellPadding={6}>
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>In force now</th>
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
                      <td>{riskFieldLabel(f)}</td>
                      <td>{String(view.effective?.[f])}</td>
                      <td>
                        {pending
                          ? `${pending.value} from ${pending.effectiveAt} (in ${formatRemaining(Math.max(0, new Date(pending.effectiveAt).getTime() - now.getTime()))})`
                          : '-'}
                      </td>
                      <td>
                        {f === 'minRewardToRisk'
                          ? 'none (warning only), ' + CEILING[f]
                          : CEILING[f]}
                      </td>
                      <td>
                        <input
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
            <p>
              <button type="submit">Save settings</button>
            </p>
          </form>
        </>
      )}

      <h2>Position-size calculator</h2>
      <p>
        Size = (equity × risk %) ÷ (distance to the stop), always rounded <strong>down</strong>.
        Fees are an estimate of the whole round trip as a percent of the trade value.
      </p>
      <form method="get">
        <input type="hidden" name="account" value={accountId} />
        <p>
          <label>
            Direction{' '}
            <select name="direction" defaultValue={sp.direction ?? 'long'}>
              <option>long</option>
              <option>short</option>
            </select>
          </label>{' '}
          <label>
            Entry <input name="entry" defaultValue={sp.entry ?? ''} size={10} inputMode="decimal" />
          </label>{' '}
          <label>
            Stop-loss{' '}
            <input name="stop" defaultValue={sp.stop ?? ''} size={10} inputMode="decimal" />
          </label>{' '}
          <label>
            Target (optional){' '}
            <input name="target" defaultValue={sp.target ?? ''} size={10} inputMode="decimal" />
          </label>
        </p>
        <p>
          <label>
            Risk % (blank = your limit){' '}
            <input name="risk" defaultValue={sp.risk ?? ''} size={6} inputMode="decimal" />
          </label>{' '}
          <label>
            Size step{' '}
            <input name="step" defaultValue={sp.step ?? ''} size={8} inputMode="decimal" />
          </label>{' '}
          <label>
            Minimum size{' '}
            <input name="min" defaultValue={sp.min ?? ''} size={8} inputMode="decimal" />
          </label>{' '}
          <label>
            Estimated fees % (round trip){' '}
            <input name="fee" defaultValue={sp.fee ?? ''} size={6} inputMode="decimal" />
          </label>
        </p>
        <button type="submit">Calculate</button>
      </form>
      {calc &&
        (calc.ok ? (
          <table border={1} cellPadding={6}>
            <tbody>
              <tr>
                <th align="left">Size</th>
                <td>
                  <strong>{calc.size}</strong>
                </td>
              </tr>
              <tr>
                <th align="left">Risk budget</th>
                <td>{calc.riskBudget}</td>
              </tr>
              <tr>
                <th align="left">Money at risk if the stop is hit</th>
                <td>{calc.riskAmount}</td>
              </tr>
              <tr>
                <th align="left">Estimated fees</th>
                <td>{calc.estimatedFees}</td>
              </tr>
              <tr>
                <th align="left">Risk used (% of equity, rounded up)</th>
                <td>{calc.riskPercentUsed}</td>
              </tr>
              <tr>
                <th align="left">Trade value (size × entry)</th>
                <td>{calc.notional}</td>
              </tr>
              <tr>
                <th align="left">Reward-to-risk</th>
                <td>{calc.rewardToRisk ?? 'no target given'}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <div role="alert">
            <p>❌ No size can be calculated:</p>
            <ul>
              {calc.problems.map((p) => (
                <li key={p.code + p.message}>{p.message}</li>
              ))}
            </ul>
          </div>
        ))}

      <h2>Recent risk events (newest first)</h2>
      {events.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <table border={1} cellPadding={6}>
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
                <td>{e.tradeId ?? ''}</td>
                <td>{e.reason}</td>
                <td>
                  <small>
                    {e.detailsJson.length > 160 ? e.detailsJson.slice(0, 160) + '…' : e.detailsJson}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
