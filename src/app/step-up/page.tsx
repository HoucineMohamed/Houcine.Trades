import { guardedPage } from '../_lib/guard';
import { stepUpAction } from './actions';

interface SearchParams {
  next?: string;
  e?: string;
  wait?: string;
}

const safeNext = (value: string | undefined): string =>
  value && /^\/[A-Za-z0-9/_-]{0,100}$/.test(value) && !value.startsWith('//') ? value : '/';

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<SearchParams> }) => {
    const sp = await searchParams;
    const wait = Math.min(Math.max(Number.parseInt(sp.wait ?? '', 10) || 0, 1), 900);
    return (
      <main className="narrow">
        <h1>Confirm with a fresh code</h1>
        <p>
          Sensitive actions (loosening a risk limit, resetting a halt, logging an override, security
          settings) need a code from your authenticator app, entered in the last 5 minutes.
        </p>
        {ctx.auth && <p role="status">🔓 A code was already accepted in the last 5 minutes.</p>}
        {sp.e === 'throttled' && (
          <p role="alert">❌ Too many attempts. Wait {wait} seconds before trying again.</p>
        )}
        {sp.e === 'invalid' && <p role="alert">❌ The code was not accepted.</p>}
        <form action={stepUpAction}>
          <input type="hidden" name="next" value={safeNext(sp.next)} />
          <p>
            <label>
              Code (6 digits){' '}
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                size={8}
              />
            </label>
          </p>
          <button type="submit">Confirm</button>
        </form>
      </main>
    );
  },
);
