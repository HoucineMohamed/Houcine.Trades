/**
 * The "fresh authenticator code" box for sensitive forms. If a code was already accepted in the
 * last 5 minutes it says so and asks for nothing; otherwise it asks for the current 6-digit code.
 */
export function StepUpField({ fresh }: { fresh: boolean }) {
  if (fresh) {
    return (
      <p role="status">
        <small>🔓 A fresh code was accepted in the last 5 minutes. No code needed right now.</small>
      </p>
    );
  }
  return (
    <p>
      <label>
        Authenticator code (6 digits){' '}
        <input
          name="stepUpCode"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          size={8}
        />
      </label>{' '}
      <small>Needed for this action. Not needed to tighten a limit or start a halt.</small>
    </p>
  );
}
