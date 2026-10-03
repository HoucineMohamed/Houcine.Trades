import { parseWith, ValidationError } from '../errors';
import { closeTradeSchema, createTradeSchema, editTradeSchema, openTradeSchema } from './inputs';
import type { TradeFields, TradeStatus } from './types';
import { assertValidTrade } from './validation';

/**
 * Trade lifecycle. Allowed moves only:
 *   planned -> open -> closed,   planned -> cancelled
 * Every function here is pure: it takes the current trade and returns the new trade fields
 * (or throws ValidationError). Saving them is the data layer's job.
 */

const ALLOWED_TRANSITIONS: Record<TradeStatus, readonly TradeStatus[]> = {
  planned: ['open', 'cancelled'],
  open: ['closed'],
  closed: [],
  cancelled: [],
};

export function canTransition(from: TradeStatus, to: TradeStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TradeStatus, to: TradeStatus): void {
  if (!canTransition(from, to)) {
    const next = ALLOWED_TRANSITIONS[from];
    throw new ValidationError([
      {
        field: 'status',
        message:
          `A ${from} trade cannot become ${to}. ` +
          (next.length > 0
            ? `Allowed next step: ${next.join(' or ')}.`
            : `A ${from} trade is final.`),
      },
    ]);
  }
}

/** Fields copied from the current trade (drops id and timestamps if a full Trade is passed). */
function fieldsOf(t: TradeFields): TradeFields {
  return {
    accountId: t.accountId,
    setupId: t.setupId,
    symbol: t.symbol,
    assetClass: t.assetClass,
    direction: t.direction,
    status: t.status,
    plannedEntry: t.plannedEntry,
    stopLoss: t.stopLoss,
    initialStopLoss: t.initialStopLoss,
    takeProfit: t.takeProfit,
    size: t.size,
    quoteCurrency: t.quoteCurrency,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    fees: t.fees,
    feesCurrency: t.feesCurrency,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    planNotes: t.planNotes,
    reviewNotes: t.reviewNotes,
    emotion: t.emotion,
    screenshotPath: t.screenshotPath,
  };
}

/** Validates new-trade input and returns the fields to store. */
export function buildNewTrade(input: unknown): TradeFields {
  const parsed = parseWith(createTradeSchema, input);
  return assertValidTrade({
    ...parsed,
    // A trade created already open starts with its current stop; a planned one gets it on opening.
    initialStopLoss: parsed.status === 'open' ? parsed.stopLoss : null,
    exitPrice: null,
    closedAt: null,
    reviewNotes: '',
  });
}

/** planned -> open. The real entry price is checked against the stop-loss, which is frozen as the initial stop. */
export function openTrade(current: TradeFields, input: unknown): TradeFields {
  assertTransition(current.status, 'open');
  const { entryPrice, openedAt } = parseWith(openTradeSchema, input);
  return assertValidTrade({
    ...fieldsOf(current),
    status: 'open',
    entryPrice,
    openedAt,
    initialStopLoss: current.stopLoss,
  });
}

/** open -> closed. Needs an exit price and a closed time not earlier than the opened time. */
export function closeTrade(current: TradeFields, input: unknown): TradeFields {
  assertTransition(current.status, 'closed');
  const { exitPrice, closedAt, ...optional } = parseWith(closeTradeSchema, input);
  const defined = Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined));
  return assertValidTrade({
    ...fieldsOf(current),
    ...defined,
    status: 'closed',
    exitPrice,
    closedAt,
  });
}

/** planned -> cancelled. */
export function cancelTrade(current: TradeFields): TradeFields {
  assertTransition(current.status, 'cancelled');
  return assertValidTrade({ ...fieldsOf(current), status: 'cancelled' });
}

type EditableKey = keyof ReturnType<(typeof editTradeSchema)['parse']>;

const JOURNAL_FIELDS: EditableKey[] = ['reviewNotes', 'emotion', 'screenshotPath'];

/** Which fields may still be edited in each status. Closed trades keep their numbers locked. */
const EDITABLE: Record<TradeStatus, readonly EditableKey[]> = {
  planned: [
    'setupId',
    'symbol',
    'assetClass',
    'direction',
    'plannedEntry',
    'stopLoss',
    'takeProfit',
    'size',
    'quoteCurrency',
    'fees',
    'feesCurrency',
    'planNotes',
    ...JOURNAL_FIELDS,
  ],
  open: [
    'setupId',
    'stopLoss',
    'takeProfit',
    'fees',
    'feesCurrency',
    'planNotes',
    ...JOURNAL_FIELDS,
  ],
  closed: JOURNAL_FIELDS,
  cancelled: [],
};

export function editableFields(status: TradeStatus): readonly string[] {
  return EDITABLE[status];
}

/** Applies an edit, enforcing the per-status locks and re-checking every trade rule. */
export function editTrade(current: TradeFields, patch: unknown): TradeFields {
  if (current.status === 'cancelled') {
    throw new ValidationError([
      { field: 'status', message: 'A cancelled trade is locked and cannot be edited' },
    ]);
  }
  const parsed = parseWith(editTradeSchema, patch);
  const changes = Object.entries(parsed).filter(([, v]) => v !== undefined);
  const allowed = new Set<string>(EDITABLE[current.status]);
  const locked = changes.filter(([key]) => !allowed.has(key));
  if (locked.length > 0) {
    throw new ValidationError(
      locked.map(([key]) => ({
        field: key,
        message: `cannot be changed on a ${current.status} trade`,
      })),
    );
  }
  return assertValidTrade({ ...fieldsOf(current), ...Object.fromEntries(changes) });
}
