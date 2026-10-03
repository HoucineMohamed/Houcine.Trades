import { localToUtc, orNull, orUndefined, toId, type FormValues } from '../_lib/form';

/**
 * Turns raw form text into the input the domain expects. This only fixes up "how HTML sends
 * things" (blank = missing, local time -> UTC). All real validation happens in the domain.
 * A missing required value becomes `undefined` so the domain answers "X is required".
 */

export function createInputFromForm(v: FormValues) {
  return {
    accountId: toId(v.accountId),
    setupId: toId(v.setupId) ?? null,
    symbol: v.symbol,
    assetClass: v.assetClass,
    direction: v.direction,
    status: orUndefined(v.status),
    plannedEntry: orUndefined(v.plannedEntry),
    stopLoss: orUndefined(v.stopLoss),
    takeProfit: orNull(v.takeProfit),
    size: orUndefined(v.size),
    quoteCurrency: v.quoteCurrency,
    entryPrice: orNull(v.entryPrice),
    openedAt: localToUtc(v.openedAt) ?? null,
    fees: orUndefined(v.fees),
    feesCurrency: orUndefined(v.feesCurrency),
    planNotes: v.planNotes ?? '',
    emotion: v.emotion ?? '',
    screenshotPath: orNull(v.screenshotPath),
  };
}

/** Only fields that were actually submitted are included (locked fields are disabled in the form). */
export function editPatchFromForm(v: FormValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const has = (key: string) => key in v;
  if (has('setupId')) patch.setupId = toId(v.setupId) ?? null;
  for (const key of ['symbol', 'assetClass', 'direction', 'quoteCurrency'] as const) {
    if (has(key)) patch[key] = v[key];
  }
  for (const key of ['plannedEntry', 'stopLoss', 'size', 'fees', 'feesCurrency'] as const) {
    if (has(key)) patch[key] = orUndefined(v[key]);
  }
  if (has('takeProfit')) patch.takeProfit = orNull(v.takeProfit);
  if (has('screenshotPath')) patch.screenshotPath = orNull(v.screenshotPath);
  for (const key of ['planNotes', 'reviewNotes', 'emotion'] as const) {
    if (has(key)) patch[key] = v[key] ?? '';
  }
  return patch;
}

export const openInputFromForm = (v: FormValues) => ({
  entryPrice: orUndefined(v.entryPrice),
  openedAt: localToUtc(v.openedAt),
});

export const closeInputFromForm = (v: FormValues) => ({
  exitPrice: orUndefined(v.exitPrice),
  closedAt: localToUtc(v.closedAt),
  fees: orUndefined(v.fees),
});
