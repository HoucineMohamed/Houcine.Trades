import { redirect } from 'next/navigation';
import { loginAction } from './actions';
import { publicPage } from '../_lib/guard';

interface SearchParams {
  e?: string;
  wait?: string;
}

function message(sp: SearchParams): string | null {
  if (sp.e === 'throttled') {
    const wait = Math.min(Math.max(Number.parseInt(sp.wait ?? '', 10) || 0, 1), 900);
    return `Too many attempts. Wait ${wait} seconds before trying again.`;
  }
  if (sp.e === 'not_configured') {
    return 'Sign-in is not set up on this computer yet. See the README, "Create the owner".';
  }
  if (sp.e) return 'Sign-in failed. Check your password and your code.';
  return null;
}

export default publicPage(async (ctx, props: { searchParams: Promise<SearchParams> }) => {
  if (ctx.signedIn) redirect('/');
  const sp = await props.searchParams;
  const problem = message(sp);
  return (
    <main className="narrow">
      <h1>Houcine.Trades</h1>
      <p>
        Private workspace. Sign in with your password and the 6-digit code from your authenticator
        app.
      </p>
      {problem && <p role="alert">❌ {problem}</p>}
      <form action={loginAction}>
        <p>
          <label>
            Password
            <br />
            <input type="password" name="password" autoComplete="current-password" required />
          </label>
        </p>
        <p>
          <label>
            Code (or a recovery code)
            <br />
            <input
              type="text"
              name="code"
              autoComplete="one-time-code"
              inputMode="text"
              required
              maxLength={32}
            />
          </label>
        </p>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
});
