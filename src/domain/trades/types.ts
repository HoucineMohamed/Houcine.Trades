export const DIRECTIONS = ['long', 'short'] as const;
export const STATUSES = ['planned', 'open', 'closed', 'cancelled'] as const;
export const ASSET_CLASSES = ['crypto', 'forex', 'stock', 'index', 'commodity', 'other'] as const;

export type Direction = (typeof DIRECTIONS)[number];
export type TradeStatus = (typeof STATUSES)[number];
export type AssetClass = (typeof ASSET_CLASSES)[number];

/**
 * A trade as the journal sees it. Prices, size and fees are decimal STRINGS (money rule).
 * Timestamps are canonical UTC ISO strings. `size` is in units of the asset (0.5 BTC, 10 shares).
 */
export interface TradeFields {
  accountId: number;
  setupId: number | null;
  symbol: string;
  assetClass: AssetClass;
  direction: Direction;
  status: TradeStatus;
  plannedEntry: string;
  stopLoss: string;
  takeProfit: string | null;
  size: string;
  quoteCurrency: string;
  entryPrice: string | null;
  exitPrice: string | null;
  fees: string;
  feesCurrency: string;
  openedAt: string | null;
  closedAt: string | null;
  planNotes: string;
  reviewNotes: string;
  emotion: string;
  screenshotPath: string | null;
}

export interface Trade extends TradeFields {
  id: number;
  createdAt: string;
  updatedAt: string;
}
