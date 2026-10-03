import { z } from 'zod';
import { ValidationError } from '../errors';
import { currencyCode, decimalField, nonEmptyText } from '../fields';

export const ACCOUNT_MODES = ['paper', 'live'] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

export const createAccountSchema = z.strictObject({
  name: nonEmptyText('Account name', 80),
  mode: z.enum(ACCOUNT_MODES, { error: 'Mode must be paper or live' }).default('paper'),
  baseCurrency: currencyCode('Base currency'),
  startingBalance: decimalField('Starting balance', 'nonNegative'),
});

export type CreateAccountInput = z.input<typeof createAccountSchema>;

/**
 * Paper-mode guard (project rules 4 and 5). A live account may only exist when the app itself
 * is configured for live trading, which is impossible while the guard in config/env.ts is on.
 */
export function assertAccountModeAllowed(mode: AccountMode, tradingMode: string): void {
  if (mode === 'live' && tradingMode !== 'live') {
    throw new ValidationError([
      {
        field: 'mode',
        message:
          'Live accounts cannot be created: the app runs in paper mode only (real execution does not exist yet).',
      },
    ]);
  }
}
