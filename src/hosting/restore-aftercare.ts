import 'server-only';
import { revokeAllSessions } from '@/data/auth';
import { listAccounts } from '@/data/accounts';
import type { Db } from '@/data/client';
import { haltManually } from '@/data/risk';
import { ValidationError } from '@/domain/errors';
import type { Logger } from './logger';

/**
 * A restore puts a COPY OF THE PAST in place of the database. Two things in that past can be unsafe:
 *
 *  - SESSIONS. A session that was ended after the backup (a stolen one, or everything ended by a
 *    password reset) is valid again in the restored file. So every session is ended: the owner signs in
 *    again with the password and the authenticator code. (If you restored because of a break-in, also run
 *    `npm run auth:reset`: the restored file also brings back the old password.)
 *  - HALTS. A halt that began after the backup is gone from the restored file, and trading would be
 *    allowed again without anyone resetting it. So every account gets a precautionary manual halt.
 *    Resetting a halt needs a fresh authenticator code, which is the point: look at the journal first.
 *
 * Starting a halt and ending sessions are the safe directions, so neither needs a step-up. Never throws.
 */
export const RESTORE_HALT_REASON =
  'Precautionary halt after a restore from a backup: check the journal';

export function afterRestore(
  db: Db,
  now: Date,
  log: Logger,
): { sessionsEnded: number; accountsHalted: number } {
  let sessionsEnded = 0;
  let accountsHalted = 0;
  try {
    sessionsEnded = db.transaction((tx) => revokeAllSessions(tx, 'restore', now));
  } catch (e) {
    log.error('restore.sessions_not_ended', { error: e instanceof Error ? e.name : 'unknown' });
  }
  try {
    for (const account of listAccounts(db)) {
      try {
        haltManually(db, account.id, RESTORE_HALT_REASON, now);
        accountsHalted += 1;
      } catch (e) {
        // "already halted by hand" is fine; anything else must be loud (never read as "halted")
        if (!(e instanceof ValidationError && /already halted/i.test(e.message))) {
          log.error('restore.halt_not_started', { error: e instanceof Error ? e.name : 'unknown' });
        }
      }
    }
  } catch (e) {
    log.error('restore.halts_not_started', { error: e instanceof Error ? e.name : 'unknown' });
  }
  log.warn('restore.aftercare', { sessionsEnded, accountsHalted });
  return { sessionsEnded, accountsHalted };
}
