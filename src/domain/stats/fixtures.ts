import type { StatsInput, StatsTrade } from './types';

/** Test helper: a closed USDT trade with sensible defaults. Override what a test cares about. */
export function trade(over: Partial<StatsTrade> & { id: number }): StatsTrade {
  return {
    symbol: 'BTCUSDT',
    assetClass: 'crypto',
    direction: 'long',
    quoteCurrency: 'USDT',
    entryPrice: '100',
    exitPrice: '110',
    size: '1',
    initialStopLoss: '95',
    fees: '0',
    feesCurrency: 'USDT',
    closedAt: `2026-01-${String(over.id).padStart(2, '0')}T10:00:00.000Z`,
    setupId: null,
    setupName: null,
    ...over,
  };
}

export function input(
  trades: StatsTrade[],
  account: Partial<StatsInput['account']> = {},
): StatsInput {
  return {
    account: { id: 1, name: 'Paper', baseCurrency: 'USDT', startingBalance: '1000', ...account },
    trades,
  };
}
