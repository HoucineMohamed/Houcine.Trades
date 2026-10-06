import { and, desc, eq } from 'drizzle-orm';
import { computeRiskUsage, openTradeRisk, type RiskContext, type RiskUsage } from '@/domain/risk';
import { computeAccountStats, type AccountStats } from '@/domain/stats';
import { getAccount, type Account } from './accounts';
import type { Reader } from './client';
import { NotFoundError } from './errors';
import { resultsByTrade } from './journal-view';
import { loadRiskContext } from './risk';
import { trades } from './schema';
import { loadStatsInput } from './stats';

/**
 * Everything the dashboard shows, assembled from the engines' own output. No calculation lives
 * here: equity, today's result and halts come from the risk context, usage from computeRiskUsage,
 * results from the stats engine, open risk from the risk engine's openTradeRisk.
 */

export interface DashboardOpenTrade {
  id: number;
  symbol: string;
  direction: string;
  quoteCurrency: string;
  entryPrice: string | null;
  initialStopLoss: string | null;
  size: string;
  openedAt: string | null;
  /** Initial risk in the account currency from the risk engine, or why it cannot be verified. */
  risk: { amount: string | null; problem: string | null };
}

export interface DashboardClosedTrade {
  id: number;
  symbol: string;
  direction: string;
  quoteCurrency: string;
  closedAt: string | null;
  netPnl: string | null;
  netR: string | null;
}

export interface Dashboard {
  account: Account;
  risk: RiskContext;
  usage: RiskUsage;
  stats: AccountStats;
  openTrades: DashboardOpenTrade[];
  recentClosed: DashboardClosedTrade[];
  counts: { total: number; planned: number; open: number; closed: number };
}

export const RECENT_CLOSED = 8;

/** Read only: unlike the /risk page it records nothing, so opening the dashboard writes nothing. */
export function loadDashboard(db: Reader, accountId: number, now: Date = new Date()): Dashboard {
  const account = getAccount(db, accountId);
  if (!account) throw new NotFoundError(`Account ${accountId}`);
  const risk = loadRiskContext(db, accountId, now);
  const stats = computeAccountStats(loadStatsInput(db, accountId));
  const results = resultsByTrade(stats);

  const rows = db.select().from(trades).where(eq(trades.accountId, accountId)).all();
  const counts = {
    total: rows.length,
    planned: rows.filter((t) => t.status === 'planned').length,
    open: rows.filter((t) => t.status === 'open').length,
    closed: rows.filter((t) => t.status === 'closed').length,
  };

  const openTrades: DashboardOpenTrade[] = rows
    .filter((t) => t.status === 'open')
    .sort((a, b) => ((a.openedAt ?? '') < (b.openedAt ?? '') ? 1 : -1))
    .map((t) => {
      const r = openTradeRisk(
        {
          tradeId: t.id,
          quoteCurrency: t.quoteCurrency,
          entryPrice: t.entryPrice,
          initialStopLoss: t.initialStopLoss,
          size: t.size,
        },
        account.baseCurrency,
      );
      return {
        id: t.id,
        symbol: t.symbol,
        direction: t.direction,
        quoteCurrency: t.quoteCurrency,
        entryPrice: t.entryPrice,
        initialStopLoss: t.initialStopLoss,
        size: t.size,
        openedAt: t.openedAt,
        risk: r.ok
          ? { amount: r.risk.toFixed(), problem: null }
          : { amount: null, problem: r.reason },
      };
    });

  const recentClosed: DashboardClosedTrade[] = db
    .select()
    .from(trades)
    .where(and(eq(trades.accountId, accountId), eq(trades.status, 'closed')))
    .orderBy(desc(trades.closedAt), desc(trades.id))
    .limit(RECENT_CLOSED)
    .all()
    .map((t) => ({
      id: t.id,
      symbol: t.symbol,
      direction: t.direction,
      quoteCurrency: t.quoteCurrency,
      closedAt: t.closedAt,
      netPnl: results.get(t.id)?.netPnl ?? null,
      netR: results.get(t.id)?.netR.value ?? null,
    }));

  return {
    account,
    risk,
    usage: computeRiskUsage(risk),
    stats,
    openTrades,
    recentClosed,
    counts,
  };
}
