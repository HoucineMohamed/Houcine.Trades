import { getNotificationSettings, listRecentEvents, loadHealth } from '@/data/notifications';
import {
  alertProblems,
  messageFor,
  NOTIFICATION_CATEGORIES,
  NOTIFY_LIMITS,
  passesSettings,
  SEVERITIES,
  type NotificationCategory,
} from '@/domain/notifications';
import { getChannelRuntime } from '@/notifications/runtime';
import { formatLocal } from '../_lib/form';
import { guardedPage } from '../_lib/guard';
import { Help } from '../_lib/Help';
import { StepUpField } from '../_lib/StepUpField';
import {
  deliverNowAction,
  setMasterAction,
  testMessageAction,
  updateSettingsAction,
} from './actions';

interface SearchParams {
  ok?: string;
  error?: string;
}

const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  risk: 'Risk (limits, halts, overrides)',
  security: 'Security (sign-ins, recovery, settings)',
  analyst: 'Analyst (caps, failed calls)',
  system: 'System (backups, market data: not used yet)',
};

const PROBLEM_WORDS: Record<string, string> = {
  channel: 'Telegram is not set up, so nothing can be sent.',
  delivery:
    'Messages are failing to reach Telegram. The events stay in the outbox and are retried.',
  worker:
    'The worker is not running (it has not run in the last 90 seconds), so new events are not being collected. Start it with npm run notify:worker, or press Deliver now.',
  settings: 'The stored alert settings could not be read, so nothing is sent.',
  expired:
    'Some events expired without ever being sent (see the list below). They are recorded, but they never reached your phone.',
  collector:
    'Part of the app state could not be read in the last cycle, so some events may be missing.',
};

const STATUS_WORDS = {
  sent: 'sent',
  due: 'waiting to be sent',
  waiting: 'failed, will retry',
  in_flight: 'sending',
  expired: 'expired (older than 24 hours, never sent)',
  held_by_settings: 'not sent (switched off in the settings)',
} as const;

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<SearchParams> }) => {
    const sp = await searchParams;
    const now = new Date();
    const settings = getNotificationSettings(ctx.db, now);
    const runtime = getChannelRuntime();
    const effective = settings.effective;
    const healthData = loadHealth(ctx.db, now, runtime.configured);
    const problems = healthData ? alertProblems(healthData.input) : [];
    const events = listRecentEvents(ctx.db, now, 50, (e) =>
      effective ? passesSettings(e, effective) : false,
    );
    const fresh = ctx.auth !== null;
    const pendingCategories = Object.entries(settings.pending.categories);

    return (
      <main>
        <div className="page-head">
          <h1>Alerts</h1>
          <div className="lead">
            One-way phone alerts about things that happen inside this app. Nothing can be sent back
            to the app through them. <Help id="alertsWhat" label="What are alerts?" />
          </div>
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
              Telegram:{' '}
              <strong>
                {runtime.configured ? 'set up (the token and chat are never shown)' : 'not set up'}
              </strong>
              {runtime.message && <> — {runtime.message}</>}
            </li>
            <li>
              &quot;Send alerts to Telegram&quot;: <strong>{settings.master ? 'ON' : 'OFF'}</strong>
              {settings.master && settings.consentAt && (
                <> since {formatLocal(settings.consentAt)} (local time)</>
              )}
            </li>
            {settings.master && healthData === null && (
              <li role="alert">The health of the alerts could not be read (status unknown).</li>
            )}
            {problems.map((p) => (
              <li role="alert" key={p}>
                {PROBLEM_WORDS[p]}
              </li>
            ))}
            {healthData && settings.master && healthData.input.heartbeatAgeMs !== null && (
              <li>
                The worker last ran {Math.round(healthData.input.heartbeatAgeMs / 1000)} seconds
                ago.
              </li>
            )}
            {healthData && healthData.problems.length > 0 && (
              <li>Last cycle, could not read or do: {healthData.problems.join(', ')}.</li>
            )}
            {settings.problem && (
              <li role="alert">
                The stored settings could not be read ({settings.problem}). Nothing is sent.
              </li>
            )}
          </ul>
        </section>

        <section aria-labelledby="master-title">
          <h2 id="master-title">Master switch</h2>
          {settings.master ? (
            <form action={setMasterAction}>
              <p>
                Alerts are ON. Turning them off needs a fresh code and sends one last message,
                &quot;Alerts were switched off&quot;.
              </p>
              <input type="hidden" name="master" value="off" />
              <StepUpField fresh={fresh} />
              <button type="submit">Turn OFF</button>
            </form>
          ) : (
            <form action={setMasterAction}>
              <div className="notice notice-note">
                <p>
                  <strong>What is sent</strong>: short fixed messages made from event kinds,
                  percentages of a limit, counts and an account number. For example: &quot;Daily
                  loss limit: 80 % of the limit is used (account #1).&quot;
                </p>
                <p>
                  <strong>What is never sent</strong>: notes, emotions, setup names, symbols,
                  account names, balances, amounts, prices, API keys, tokens, passwords, emails or
                  IP addresses.
                </p>
                <p>
                  Messages pass through Telegram&apos;s servers, and chats with a bot are not
                  end-to-end encrypted. Telegram can read what is sent. Messages are plain text with
                  no links or buttons, and nothing you reply is read by the app.
                </p>
                <p>Only events from the moment you switch on are announced.</p>
              </div>
              <input type="hidden" name="master" value="on" />
              <p>
                <label>
                  <input type="checkbox" name="understood" value="yes" /> I read what is sent and
                  what is not, and I agree.
                </label>
              </p>
              <StepUpField fresh={fresh} />
              <button type="submit" disabled={!runtime.configured}>
                Turn ON
              </button>
              {!runtime.configured && (
                <p className="small">Set up Telegram first: run npm run notify:set-telegram.</p>
              )}
            </form>
          )}
        </section>

        <section aria-labelledby="cats-title">
          <h2 id="cats-title">What is announced</h2>
          {effective ? (
            <form action={updateSettingsAction}>
              <fieldset className="plain-fieldset">
                {NOTIFICATION_CATEGORIES.map((c) => (
                  <p key={c}>
                    <label>
                      <input
                        type="checkbox"
                        name={`cat_${c}`}
                        value="on"
                        defaultChecked={
                          settings.pending.categories[c]
                            ? settings.pending.categories[c]?.value
                            : effective.categories[c]
                        }
                      />{' '}
                      {CATEGORY_LABEL[c]}
                      {settings.pending.categories[c] && (
                        <> (switching off at {settings.pending.categories[c]?.effectiveAt} UTC)</>
                      )}
                    </label>
                  </p>
                ))}
              </fieldset>
              <div className="field">
                <label htmlFor="f-minSeverity">Minimum severity</label>
                <select
                  id="f-minSeverity"
                  name="minSeverity"
                  defaultValue={settings.pending.minSeverity?.value ?? effective.minSeverity}
                >
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="small">
                Critical events are always announced while alerts are on. Switching something on
                applies at once. Switching a category off or raising the minimum severity needs a
                fresh code and takes effect after 24 hours; ask for the louder setting to cancel it.{' '}
                <Help id="alertsQuieter" label="Why 24 hours?" />
              </div>
              <StepUpField fresh={fresh} />
              <button type="submit">Save</button>
            </form>
          ) : (
            <p role="alert">The settings could not be read, so nothing is sent.</p>
          )}
          {(pendingCategories.length > 0 || settings.pending.minSeverity) && (
            <>
              <h3>Waiting to take effect</h3>
              <ul>
                {pendingCategories.map(([c, p]) => (
                  <li key={c}>
                    Category {c} off at {p?.effectiveAt} (UTC)
                  </li>
                ))}
                {settings.pending.minSeverity && (
                  <li>
                    Minimum severity {settings.pending.minSeverity.value} at{' '}
                    {settings.pending.minSeverity.effectiveAt} (UTC)
                  </li>
                )}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="try-title">
          <h2 id="try-title">Try it</h2>
          <div className="actions-row">
            <form action={testMessageAction}>
              <button type="submit" className="secondary">
                Send test message
              </button>
            </form>
            <form action={deliverNowAction}>
              <button type="submit" className="secondary">
                Deliver now
              </button>
            </form>
          </div>
          <p className="small">
            &quot;Deliver now&quot; collects new events and sends what is waiting. The worker (npm
            run notify:worker) does the same every 30 seconds.
          </p>
        </section>

        <section aria-labelledby="ceilings-title">
          <h2 id="ceilings-title">Ceilings (fixed in the code)</h2>
          <ul>
            <li>
              At most {NOTIFY_LIMITS.perHour} messages an hour, plus{' '}
              {NOTIFY_LIMITS.criticalReservePerHour} more that only critical events may use. Above
              that, one summary says how many wait and the rest stay in the outbox.{' '}
              <Help id="alertsFlood" label="More" />
            </li>
            <li>
              A failed delivery is retried after 1, 2, 4, 8 and 16 minutes, then every 30 minutes.
            </li>
            <li>
              An event that could not be delivered for 24 hours expires: it is never sent, but stays
              on this page.
            </li>
          </ul>
        </section>

        <section aria-labelledby="events-title">
          <h2 id="events-title">Recent events</h2>
          {events.length === 0 ? (
            <p>No events yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When (local)</th>
                    <th>Category</th>
                    <th>Severity</th>
                    <th>Message</th>
                    <th>Delivery</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((r) => (
                    <tr key={r.id}>
                      <td>{formatLocal(r.event.occurredAt)}</td>
                      <td>{r.event.category}</td>
                      <td>{r.event.severity}</td>
                      <td>{messageFor(r.event)}</td>
                      <td>
                        {STATUS_WORDS[r.status]}
                        {r.lastErrorCode && r.status !== 'sent' && (
                          <> (last error: {r.lastErrorCode.replace('_', ' ')})</>
                        )}
                      </td>
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
