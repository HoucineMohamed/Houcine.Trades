import Link from 'next/link';
import { REQUEST_LIMITS } from '@/domain/analyst';
import { selectedAccount } from '../../_lib/account';
import { guardedPage } from '../../_lib/guard';
import { runTutorAction } from '../actions';

export default guardedPage(
  async (ctx, { searchParams }: { searchParams: Promise<{ error?: string }> }) => {
    const sp = await searchParams;
    const { selected } = await selectedAccount(ctx);
    return (
      <main>
        <div className="page-head">
          <h1>Tutor</h1>
          <p className="lead">
            Ask about a trading or risk concept. The answer is education only, using your own
            numbers as examples. No predictions, signals or advice on what to trade.{' '}
            <Link href="/analyst">Settings and usage</Link>
          </p>
        </div>
        {sp.error && (
          <p role="alert" className="notice notice-alert">
            {sp.error}
          </p>
        )}
        <form action={runTutorAction}>
          <input type="hidden" name="accountId" value={selected?.id ?? ''} />
          <div className="field wide">
            <label htmlFor="f-question">Your question</label>
            <textarea
              id="f-question"
              name="question"
              rows={4}
              maxLength={REQUEST_LIMITS.maxQuestionChars}
              required
            />
            <span className="field-hint">
              For example: &quot;What is expectancy?&quot; Up to {REQUEST_LIMITS.maxQuestionChars}{' '}
              characters. Your question and your own statistics are sent (not account names, keys or
              passwords).
            </span>
          </div>
          <button type="submit">Ask the tutor</button>
        </form>
      </main>
    );
  },
);
