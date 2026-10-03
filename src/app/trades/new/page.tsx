import Link from 'next/link';
import { listAccounts } from '@/data/accounts';
import { listSetups } from '@/data/setups';
import { guardedPage } from '../../_lib/guard';
import { createTradeAction, previewRiskAction } from '../actions';
import { TradeForm } from '../TradeForm';

export default guardedPage(async (ctx) => {
  const db = ctx.db;
  const accounts = listAccounts(db);
  const setups = listSetups(db);
  return (
    <main>
      <h1>New paper trade</h1>
      {accounts.length === 0 ? (
        <p>
          You need an account first. <Link href="/accounts">Create one here</Link>.
        </p>
      ) : (
        <TradeForm
          action={createTradeAction}
          preview={previewRiskAction}
          accounts={accounts}
          setups={setups}
          mode="create"
          initial={{
            accountId: String(accounts[0]?.id ?? ''),
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
