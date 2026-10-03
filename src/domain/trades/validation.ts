import { ValidationError, type ValidationIssue } from '../errors';
import { parseIsoUtc } from '../fields';
import { compareDecimal, isDecimalString, isPositive } from '../money/decimal';
import type { TradeFields } from './types';

/**
 * The single place that decides whether a trade is internally consistent. It runs on every
 * create, edit, open and close, so no code path can store a trade that breaks these rules.
 *
 * Project rule 4: stop_loss is mandatory, and it must sit on the correct side of the entry.
 */

const entryReference = (t: TradeFields) => t.entryPrice ?? t.plannedEntry;

export function findTradeIssues(t: TradeFields): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });

  // --- numbers: prices and size must be valid and greater than 0 -------------------------
  const goodPrice: Record<string, boolean> = {};
  const checkPositive = (
    field: string,
    label: string,
    value: string | null,
    mandatory: boolean,
  ) => {
    if (value === null || value === '') {
      goodPrice[field] = false;
      if (mandatory) add(field, `${label} is required`);
      return;
    }
    if (!isDecimalString(value)) {
      goodPrice[field] = false;
      add(field, `${label} is not a valid number`);
      return;
    }
    goodPrice[field] = isPositive(value);
    if (!goodPrice[field]) add(field, `${label} must be greater than 0`);
  };
  checkPositive('plannedEntry', 'Planned entry', t.plannedEntry, true);
  checkPositive('stopLoss', 'Stop-loss', t.stopLoss, true);
  checkPositive('takeProfit', 'Take-profit', t.takeProfit, false);
  checkPositive('size', 'Size', t.size, true);
  checkPositive('entryPrice', 'Entry price', t.entryPrice, false);
  checkPositive('exitPrice', 'Exit price', t.exitPrice, false);
  if (!isDecimalString(t.fees)) add('fees', 'Fees must be a valid number (0 or more)');

  // --- stop-loss and take-profit sides ----------------------------------------------------
  const entry = entryReference(t);
  const entryField = t.entryPrice !== null ? 'entry price' : 'planned entry';
  const entryOk = t.entryPrice !== null ? goodPrice.entryPrice : goodPrice.plannedEntry;
  if (entryOk && goodPrice.stopLoss) {
    const stopVsEntry = compareDecimal(t.stopLoss, entry);
    if (t.direction === 'long' && stopVsEntry >= 0) {
      add(
        'stopLoss',
        `For a long trade the stop-loss (${t.stopLoss}) must be below the ${entryField} (${entry})`,
      );
    }
    if (t.direction === 'short' && stopVsEntry <= 0) {
      add(
        'stopLoss',
        `For a short trade the stop-loss (${t.stopLoss}) must be above the ${entryField} (${entry})`,
      );
    }
  }
  if (entryOk && t.takeProfit !== null && goodPrice.takeProfit) {
    const tpVsEntry = compareDecimal(t.takeProfit, entry);
    if (t.direction === 'long' && tpVsEntry <= 0) {
      add(
        'takeProfit',
        `For a long trade the take-profit (${t.takeProfit}) must be above the ${entryField} (${entry})`,
      );
    }
    if (t.direction === 'short' && tpVsEntry >= 0) {
      add(
        'takeProfit',
        `For a short trade the take-profit (${t.takeProfit}) must be below the ${entryField} (${entry})`,
      );
    }
  }

  // --- fields that must (or must not) exist for each status -------------------------------
  const mustBeEmpty = (field: keyof TradeFields, label: string) => {
    if (t[field] !== null) add(field, `${label} must be empty on a ${t.status} trade`);
  };
  const mustExist = (field: keyof TradeFields, label: string) => {
    if (t[field] === null) add(field, `${label} is required on a ${t.status} trade`);
  };
  switch (t.status) {
    case 'planned':
    case 'cancelled':
      mustBeEmpty('entryPrice', 'Entry price');
      mustBeEmpty('openedAt', 'Opened time');
      mustBeEmpty('exitPrice', 'Exit price');
      mustBeEmpty('closedAt', 'Closed time');
      break;
    case 'open':
      mustExist('entryPrice', 'Entry price');
      mustExist('openedAt', 'Opened time');
      mustBeEmpty('exitPrice', 'Exit price');
      mustBeEmpty('closedAt', 'Closed time');
      break;
    case 'closed':
      mustExist('entryPrice', 'Entry price');
      mustExist('openedAt', 'Opened time');
      mustExist('exitPrice', 'Exit price');
      mustExist('closedAt', 'Closed time');
      break;
  }

  // --- time order -------------------------------------------------------------------------
  for (const [field, value] of [
    ['openedAt', t.openedAt],
    ['closedAt', t.closedAt],
  ] as const) {
    if (value !== null && parseIsoUtc(value) === null)
      add(field, `${field} is not a valid UTC time`);
  }
  if (t.openedAt !== null && t.closedAt !== null) {
    const opened = parseIsoUtc(t.openedAt);
    const closed = parseIsoUtc(t.closedAt);
    if (opened && closed && closed.getTime() < opened.getTime()) {
      add(
        'closedAt',
        `Closed time (${t.closedAt}) cannot be earlier than opened time (${t.openedAt})`,
      );
    }
  }

  return issues;
}

/** Throws ValidationError listing every problem, or returns the trade unchanged. */
export function assertValidTrade<T extends TradeFields>(trade: T): T {
  const issues = findTradeIssues(trade);
  if (issues.length > 0) throw new ValidationError(issues);
  return trade;
}
