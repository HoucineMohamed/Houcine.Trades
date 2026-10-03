'use client';

import { useActionState } from 'react';
import { emptySecurityState, type SecurityFormState } from './state';

type Action = (prev: SecurityFormState, formData: FormData) => Promise<SecurityFormState>;

function Result({ state }: { state: SecurityFormState }) {
  return (
    <>
      {state.error && <p role="alert">❌ {state.error}</p>}
      {state.message && <p role="status">✅ {state.message}</p>}
      {state.codes && <pre className="box">{state.codes.join('\n')}</pre>}
    </>
  );
}

function CodeField({ fresh }: { fresh: boolean }) {
  return fresh ? (
    <p>
      <small>🔓 A fresh code was accepted in the last 5 minutes. No code needed right now.</small>
    </p>
  ) : (
    <p>
      <label>
        Authenticator code (6 digits){' '}
        <input name="stepUpCode" inputMode="numeric" autoComplete="one-time-code" size={8} />
      </label>
    </p>
  );
}

export function ChangePasswordForm({ action, fresh }: { action: Action; fresh: boolean }) {
  const [state, formAction, pending] = useActionState(action, emptySecurityState);
  return (
    <form action={formAction}>
      <Result state={state} />
      <p>
        <label>
          Current password{' '}
          <input type="password" name="currentPassword" autoComplete="current-password" required />
        </label>
      </p>
      <p>
        <label>
          New password (at least 12 characters){' '}
          <input type="password" name="newPassword" autoComplete="new-password" required />
        </label>
      </p>
      <p>
        <label>
          New password again{' '}
          <input type="password" name="newPasswordAgain" autoComplete="new-password" required />
        </label>
      </p>
      <CodeField fresh={fresh} />
      <button type="submit" disabled={pending}>
        Change password
      </button>
    </form>
  );
}

export function CodeActionForm({
  action,
  fresh,
  label,
}: {
  action: Action;
  fresh: boolean;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(action, emptySecurityState);
  return (
    <form action={formAction}>
      <Result state={state} />
      <CodeField fresh={fresh} />
      <button type="submit" disabled={pending}>
        {label}
      </button>
    </form>
  );
}
