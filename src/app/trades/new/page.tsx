import Link from 'next/link';
import { getAnalystAvailability } from '@/analyst/runtime';
import { getAiSettings } from '@/data/analyst';
import { listAccounts } from '@/data/accounts';
import { listSetups } from '@/data/setups';
import { selectedAccount } from '../../_lib/account';
import { guardedPage } from '../../_lib/guard';
import { Help } from '../../_lib/Help';
import { askPlanReviewAction } from '../../analyst/actions';
import { createTradeAction, previewRiskAction, sizeSuggestionAction } from '../actions';
import { TradeForm } from '../TradeForm';

export default guardedPage(async (ctx) => {
  const accounts = listAccounts(ctx.db);
  const setups = listSetups(ctx.db);
  const { selected } = await selectedAccount(ctx);
  const availability = getAnalystAvailability();
  const settings = getAiSettings(ctx.db);
  const unavailable = !availability.keyReady
    ? (availability.message ?? 'The analyst is off.')
    : settings.problem !== null
      ? 'The analyst settings could not be read, so nothing is sent.'
      : !settings.consent
        ? 'The privacy switch "Send journal data to the AI" is off. Turn it on at the Analyst page to use this.'
        : null;
  return (
    <main>
      <div className="page-head">
        <h1>New paper trade</h1>
        <div className="lead">
          Log a plan before you take it. The risk engine checks it live as you type and has the
          final say. <Help id="overrides" label="What is an override?" />
        </div>
      </div>
      {accounts.length === 0 ? (
        <div className="empty">
          <h2>You need an account first</h2>
          <p>
            <Link href="/accounts">Create a paper account</Link>, then come back here.
          </p>
        </div>
      ) : (
        <TradeForm
          action={createTradeAction}
          preview={previewRiskAction}
          sizeHelper={sizeSuggestionAction}
          accounts={accounts}
          setups={setups}
          mode="create"
          stepUpFresh={ctx.auth !== null}
          analyst={{ ask: askPlanReviewAction, unavailable }}
          initial={{
            accountId: String(selected?.id ?? accounts[0]?.id ?? ''),
            quoteCurrency: selected?.baseCurrency ?? '',
            assetClass: 'crypto',
            direction: 'long',
            status: 'planned',
          }}
          submitLabel="Create trade"
        />
      )}
    </main>
  );
});
