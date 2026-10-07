import Link from 'next/link';
import { getAnalystAvailability } from '@/analyst/runtime';
import {
  AiDataError,
  getAiSettings,
  getUsageTotals,
  listRecentUsage,
  listReviews,
} from '@/data/analyst';
import {
  AI_CAP_CEILINGS,
  AI_COMMENTARY_LABEL,
  aiCapLabel,
  KIND_LABELS,
  PRICES_LAST_VERIFIED,
  type AiCapField,
} from '@/domain/analyst';
import { formatLocal } from '../_lib/form';
import { guardedPage } from '../_lib/guard';
import { StepUpField } from '../_lib/StepUpField';
import { MetricTile } from '../_lib/ui';
import { setConsentAction, updateCapsAction } from './actions';

interface SearchParams {
  ok?: string;
  error?: string;
}

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<SearchParams> }) => {
    const sp = await searchParams;
    const now = new Date();
    const settings = getAiSettings(ctx.db, now);
    const availability = getAnalystAvailability();
    let totals: ReturnType<typeof getUsageTotals> | null = null;
    let usageProblem: string | null = null;
    try {
      totals = getUsageTotals(ctx.db, now);
    } catch (error) {
      if (!(error instanceof AiDataError)) throw error;
      usageProblem = 'The usage log could not be read, so the analyst is stopped until it can be.';
    }
    const recent = listRecentUsage(ctx.db, 20);
    const reviews = listReviews(ctx.db, 50);
    const fresh = ctx.auth !== null;
    const caps = settings.effective;
    const pending = Object.entries(settings.pending);

    return (
      <main>
        <div className="page-head">
          <h1>Analyst</h1>
          <p className="lead">
            An AI that reviews and explains your journal. {AI_COMMENTARY_LABEL}. It cannot approve,
            refuse, change a plan, a limit or a halt, or touch an order.
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

        <section aria-labelledby="status-title">
          <h2 id="status-title">Status</h2>
          <ul>
            <li>
              API key:{' '}
              {availability.keyReady ? (
                <strong>set (it is never shown)</strong>
              ) : (
                <strong>not usable</strong>
              )}
              {availability.message && <> — {availability.message}</>}
            </li>
            <li>
              Model: <strong>{availability.model ?? 'not available'}</strong>
            </li>
            <li>
              Privacy switch &quot;Send journal data to the AI&quot;:{' '}
              <strong>{settings.consent ? 'ON' : 'OFF'}</strong>
            </li>
            {settings.problem && (
              <li role="alert">
                The stored analyst settings could not be read ({settings.problem}). Nothing is sent.
              </li>
            )}
          </ul>
          <p>
            <Link href="/analyst/review">Weekly review</Link> ·{' '}
            <Link href="/analyst/tutor">Tutor</Link> · Plan review: on the{' '}
            <Link href="/trades/new">new trade</Link> page, after the risk check.
          </p>
        </section>

        <section aria-labelledby="privacy-title">
          <h2 id="privacy-title">Privacy switch</h2>
          {settings.consent ? (
            <form action={setConsentAction}>
              <p>
                The switch is ON. Each request sends the data described below to the AI provider.
              </p>
              <input type="hidden" name="consent" value="off" />
              <button type="submit">Turn OFF (nothing will be sent)</button>
            </form>
          ) : (
            <form action={setConsentAction}>
              <div className="notice notice-note">
                <p>
                  <strong>What is sent</strong> when you ask the analyst something:
                </p>
                <ul>
                  <li>the trade plan or the closed trades you picked, with prices and sizes</li>
                  <li>the statistics and the risk engine&apos;s verdict and numbers</li>
                  <li>
                    your notes, emotions and setup names (emails, key-like text and long numbers are
                    masked)
                  </li>
                  <li>the questions you type</li>
                </ul>
                <p>
                  <strong>What is never sent:</strong> API keys, your password, authenticator codes
                  or secrets, session data, account names or numbers.
                </p>
                <p>
                  The text goes to Anthropic, the AI provider, over HTTPS. The AI has no tools: it
                  cannot reach your database, your settings or any order.
                </p>
              </div>
              <input type="hidden" name="consent" value="on" />
              <p>
                <label>
                  <input type="checkbox" name="understood" value="yes" /> I read what is sent and
                  what is not, and I agree.
                </label>
              </p>
              <StepUpField fresh={fresh} />
              <button type="submit">Turn ON</button>
            </form>
          )}
        </section>

        <section aria-labelledby="usage-title">
          <h2 id="usage-title">Usage</h2>
          <p className="notice notice-note">
            The cost shown is an <strong>ESTIMATE</strong> worked out from our own price table (last
            verified {PRICES_LAST_VERIFIED}). The{' '}
            <strong>spend limit you set in the Anthropic console is the real hard stop</strong>;
            these caps are an extra safety net.
          </p>
          {usageProblem && (
            <p role="alert" className="notice notice-alert">
              {usageProblem}
            </p>
          )}
          {totals && caps && (
            <div className="grid grid-tight">
              <MetricTile label="Calls today (UTC)" sub="resets at UTC midnight">
                {totals.callsToday} of {caps.dailyCalls}
              </MetricTile>
              <MetricTile label="Calls this month (UTC)" sub="resets on the 1st">
                {totals.callsThisMonth} of {caps.monthlyCalls}
              </MetricTile>
              <MetricTile label="Estimated cost this month" sub="ESTIMATE, in US dollars">
                {totals.costThisMonthUsd} of {caps.monthlyCostUsd} USD
              </MetricTile>
            </div>
          )}
          <p className="small">
            When a cap is reached the analyst stops until the period resets. The rest of the app is
            not affected.
          </p>
        </section>

        <section aria-labelledby="caps-title">
          <h2 id="caps-title">Spend caps</h2>
          {caps ? (
            <form action={updateCapsAction}>
              <div className="form-grid">
                {(
                  [
                    ['dailyCalls', caps.dailyCalls],
                    ['monthlyCalls', caps.monthlyCalls],
                    ['monthlyCostUsd', caps.monthlyCostUsd],
                  ] as [AiCapField, string | number][]
                ).map(([field, value]) => (
                  <div className="field" key={field}>
                    <label htmlFor={`f-${field}`}>{aiCapLabel(field)}</label>
                    <input
                      id={`f-${field}`}
                      name={field}
                      defaultValue={String(value)}
                      inputMode={field === 'monthlyCostUsd' ? 'decimal' : 'numeric'}
                    />
                    <span className="field-hint">hard ceiling {AI_CAP_CEILINGS[field]}</span>
                  </div>
                ))}
              </div>
              <p className="small">
                A lower cap applies at once. A higher cap waits 24 hours and needs a fresh
                authenticator code. Nothing can go above the hard ceilings.
              </p>
              <StepUpField fresh={fresh} />
              <button type="submit">Save caps</button>
            </form>
          ) : (
            <p role="alert">The caps could not be read, so nothing is sent.</p>
          )}
          {pending.length > 0 && (
            <>
              <h3>Waiting to take effect</h3>
              <ul>
                {pending.map(([field, p]) => (
                  <li key={field}>
                    {aiCapLabel(field as AiCapField)} → {p?.value} at {p?.effectiveAt} (UTC)
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="history-title">
          <h2 id="history-title">History</h2>
          {reviews.length === 0 ? (
            <p>No stored answers yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When (local)</th>
                    <th>Kind</th>
                    <th>About</th>
                    <th>Flags</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {reviews.map((r) => (
                    <tr key={r.id}>
                      <td>{formatLocal(r.createdAt)}</td>
                      <td>{KIND_LABELS[r.kind]}</td>
                      <td>{r.subject}</td>
                      <td>
                        {r.checks === null ? (
                          <span className="badge badge-unverified">unreadable</span>
                        ) : r.checks.flagged ? (
                          <span className="badge badge-unverified">flagged</span>
                        ) : (
                          <span className="na">none</span>
                        )}
                      </td>
                      <td>
                        <Link className="row-link" href={`/analyst/reviews/${r.id}`}>
                          Read again
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-labelledby="log-title">
          <h2 id="log-title">Recent requests</h2>
          <p className="small">
            The log keeps the time, feature, model, token counts, estimated cost and status. It
            never stores what was sent, the answers or any secret.
          </p>
          {recent.length === 0 ? (
            <p>No requests yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When (local)</th>
                    <th>Feature</th>
                    <th>Model</th>
                    <th>Tokens in / out</th>
                    <th>Estimated cost (USD)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((u) => (
                    <tr key={u.id}>
                      <td>{formatLocal(u.createdAt)}</td>
                      <td>{KIND_LABELS[u.feature]}</td>
                      <td>{u.model}</td>
                      <td>
                        {u.inputTokens} / {u.outputTokens}
                      </td>
                      <td>{u.estimatedCostUsd}</td>
                      <td>{u.status.replace('_', ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    );
  },
);
