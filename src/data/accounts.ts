import { desc, eq } from 'drizzle-orm';
import { getEnv } from '@/config/env';
import { assertAccountModeAllowed, createAccountSchema } from '@/domain/accounts/account';
import { parseWith } from '@/domain/errors';
import type { Db, Reader } from './client';
import { RISK_DEFAULTS } from '@/domain/risk/settings';
import { appendRiskEvent } from './risk-events';
import { accounts, riskSettings, type AccountRow } from './schema';

export type Account = AccountRow;

export interface RepoOptions {
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Defaults to the validated TRADING_MODE from the environment. */
  tradingMode?: string;
}

/** Creates an account. Live accounts are refused while the paper-mode guard is on. */
export function createAccount(db: Db, input: unknown, options: RepoOptions = {}): Account {
  const data = parseWith(createAccountSchema, input);
  assertAccountModeAllowed(data.mode, options.tradingMode ?? getEnv().TRADING_MODE);
  const now = (options.now ?? (() => new Date()))();
  // Every account is born with the default risk settings (a missing row would fail closed).
  return db.transaction((tx) => {
    const account = tx
      .insert(accounts)
      .values({ ...data, createdAt: now.toISOString() })
      .returning()
      .get();
    tx.insert(riskSettings)
      .values({
        accountId: account.id,
        settingsJson: JSON.stringify(RISK_DEFAULTS),
        pendingJson: '{}',
        updatedAt: now.toISOString(),
      })
      .run();
    appendRiskEvent(tx, {
      accountId: account.id,
      kind: 'settings_change',
      reason: 'Default risk settings created with the account',
      details: { created: true, settings: RISK_DEFAULTS },
      at: now,
    });
    return account;
  });
}

export function getAccount(db: Reader, id: number): Account | undefined {
  return db.select().from(accounts).where(eq(accounts.id, id)).get();
}

export function listAccounts(db: Db): Account[] {
  return db.select().from(accounts).orderBy(desc(accounts.id)).all();
}
