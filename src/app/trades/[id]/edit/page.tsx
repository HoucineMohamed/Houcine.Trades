import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAccount } from '@/data/accounts';
import { listSetups } from '@/data/setups';
import { getTrade } from '@/data/trades';
import { editableFields } from '@/domain/trades/lifecycle';
import { guardedPage } from '../../../_lib/guard';
import { formatLocal, type FormValues } from '../../../_lib/form';
import { updateTradeAction } from '../../actions';
import { TradeForm } from '../../TradeForm';

export default guardedPage(async (ctx, { params }: { params: Promise<{ id: string }> }) => {
  const { id: rawId } = await params;
  const id = /^\d+$/.test(rawId) ? Number(rawId) : NaN;
  const db = ctx.db;
  const trade = Number.isNaN(id) ? undefined : getTrade(db, id);
  if (!trade) notFound();

  const account = getAccount(db, trade.accountId);
  const initial: FormValues = {
    setupId: trade.setupId === null ? '' : String(trade.setupId),
    symbol: trade.symbol,
    assetClass: trade.assetClass,
    direction: trade.direction,
    plannedEntry: trade.plannedEntry,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit ?? '',
    size: trade.size,
    quoteCurrency: trade.quoteCurrency,
    fees: trade.fees,
    feesCurrency: trade.feesCurrency,
    planNotes: trade.planNotes,
    reviewNotes: trade.reviewNotes,
    emotion: trade.emotion,
    screenshotPath: trade.screenshotPath ?? '',
  };
  const editable = editableFields(trade.status);

  return (
    <main>
      <h1>
        Edit trade #{trade.id} ({trade.symbol})
      </h1>
      <p>
        Account: {account?.name} | Status: <strong>{trade.status}</strong>
        {trade.entryPrice && <> | Entry: {trade.entryPrice}</>}
        {trade.exitPrice && <> | Exit: {trade.exitPrice}</>}
        {trade.openedAt && <> | Opened: {formatLocal(trade.openedAt)}</>}
        {trade.closedAt && <> | Closed: {formatLocal(trade.closedAt)}</>}
      </p>
      {trade.status === 'cancelled' ? (
        <p>A cancelled trade is locked and cannot be edited.</p>
      ) : (
        <>
          {trade.status === 'closed' && (
            <p>
              This trade is closed: prices and size are locked. You can still update the review
              notes, emotion and screenshot.
            </p>
          )}
          {trade.status === 'open' && (
            <p>
              This trade is open: you can change stop-loss, take-profit, fees and notes. Greyed-out
              fields are locked.
            </p>
          )}
          <TradeForm
            action={updateTradeAction.bind(null, trade.id)}
            accounts={[]}
            setups={listSetups(db)}
            mode="edit"
            initial={initial}
            editable={editable}
            submitLabel="Save changes"
          />
        </>
      )}
      <p>
        <Link href="/trades">Back to trades</Link>
      </p>
    </main>
  );
});
