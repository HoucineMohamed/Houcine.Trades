import { getSecurityOverview } from '@/auth/service';
import { formatLocal } from '../_lib/form';
import { guardedPage } from '../_lib/guard';
import { changePasswordAction, logoutEverywhereAction, regenerateCodesAction } from './actions';
import { ChangePasswordForm, CodeActionForm } from './forms';

const EVENT_LABELS: Record<string, string> = {
  login_success: 'Signed in',
  login_failure: 'Failed sign-in',
  logout: 'Signed out',
  logout_all: 'Signed out everywhere',
  session_revoked: 'Session ended',
  step_up_success: 'Fresh code accepted',
  step_up_failure: 'Fresh code refused',
  password_changed: 'Password changed',
  recovery_regenerated: 'Recovery codes regenerated',
  recovery_used: 'Recovery code used',
  rate_limit_tripped: 'Rate limit started',
  owner_created: 'Owner created',
  owner_reset: 'Owner reset (command line)',
};

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<{ recovery?: string }> }) => {
    const sp = await searchParams;
    const overview = getSecurityOverview(ctx.db);
    const fresh = ctx.auth !== null;
    return (
      <main>
        <h1>Security</h1>
        {sp.recovery === 'used' && (
          <p role="alert">
            ⚠️ You signed in with a recovery code. Every other session was ended. Generate a new set
            of recovery codes below.
          </p>
        )}
        <p>
          Recovery codes left: <strong>{overview.unusedRecoveryCodes}</strong>
          {overview.unusedRecoveryCodes <= 3 && ' (running low: generate a new set)'}
        </p>

        <h2>Change password</h2>
        <ChangePasswordForm action={changePasswordAction} fresh={fresh} />

        <h2>Recovery codes</h2>
        <p>Generating a new set makes the old unused codes stop working.</p>
        <CodeActionForm
          action={regenerateCodesAction}
          fresh={fresh}
          label="Generate new recovery codes"
        />

        <h2>Sessions</h2>
        <table border={1} cellPadding={6}>
          <thead>
            <tr>
              <th>Started</th>
              <th>Last seen</th>
              <th>From</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {overview.sessions.map((s) => (
              <tr key={s.id}>
                <td>{formatLocal(s.createdAt)}</td>
                <td>{formatLocal(s.lastSeenAt)}</td>
                <td>
                  {s.ip} <small>{s.userAgent.slice(0, 60)}</small>
                </td>
                <td>
                  {s.id === ctx.session.id
                    ? 'this session'
                    : s.revokedAt
                      ? `ended (${s.revokedReason ?? ''})`
                      : 'active'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Log out everywhere</h3>
        <CodeActionForm
          action={logoutEverywhereAction}
          fresh={fresh}
          label="Log out of every session"
        />

        <h2>Recent security events</h2>
        <table border={1} cellPadding={6}>
          <thead>
            <tr>
              <th>When (local)</th>
              <th>What</th>
              <th>From</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {overview.events.map((e) => (
              <tr key={e.id}>
                <td>{formatLocal(e.createdAt)}</td>
                <td>{EVENT_LABELS[e.kind] ?? e.kind}</td>
                <td>{e.ip}</td>
                <td>{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    );
  },
);
