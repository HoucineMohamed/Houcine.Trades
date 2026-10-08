import { describe, expect, it } from 'vitest';
import { createAccount } from '@/data/accounts';
import { loadRiskContext } from '@/data/risk';
import { afterRestore, RESTORE_HALT_REASON } from '@/hosting/restore-aftercare';
import { createLogger } from '@/hosting/logger';
import { memoryDb } from '../helpers/db';

const NOW = new Date('2026-10-08T03:00:00Z');
const lines: string[] = [];
const log = createLogger({ write: (l) => lines.push(l) });
const addSession = (db: ReturnType<typeof memoryDb>, id: number) =>
  db.$client
    .prepare(
      "INSERT INTO sessions (id, token_hash, created_at, last_seen_at) VALUES (?, ?, 't', 't')",
    )
    .run(id, `hash-${id}`);

describe('after a restore', () => {
  it('every session is ended (a stolen one that was ended after the backup would otherwise live again)', () => {
    const db = memoryDb();
    addSession(db, 1);
    addSession(db, 2);
    const r = afterRestore(db, NOW, log);
    expect(r.sessionsEnded).toBe(2);
    const rows = db.$client
      .prepare('SELECT revoked_at AS at, revoked_reason AS why FROM sessions')
      .all() as { at: string; why: string }[];
    expect(rows.every((x) => x.at === NOW.toISOString() && x.why === 'restore')).toBe(true);
  });

  it('every account gets a precautionary halt (a halt that began after the backup is gone from the file)', () => {
    const db = memoryDb();
    const a = createAccount(db, { name: 'A', baseCurrency: 'USDT', startingBalance: '1000' });
    const b = createAccount(db, { name: 'B', baseCurrency: 'USDT', startingBalance: '1000' });
    expect(afterRestore(db, NOW, log).accountsHalted).toBe(2);
    for (const id of [a.id, b.id]) {
      const halts = loadRiskContext(db, id, NOW).halts;
      expect(halts.map((h) => h.kind)).toContain('manual');
    }
    expect(RESTORE_HALT_REASON.length).toBeGreaterThan(10);
  });

  it('an account that is already halted by hand is fine, and nothing is reported as an error', () => {
    const db = memoryDb();
    createAccount(db, { name: 'A', baseCurrency: 'USDT', startingBalance: '1000' });
    afterRestore(db, NOW, log);
    lines.length = 0;
    const again = afterRestore(db, NOW, log);
    expect(again.accountsHalted).toBe(0);
    expect(lines.join('\n')).not.toContain('halt_not_started');
  });

  it('never throws, even on a database that cannot be written, and says so', () => {
    const db = memoryDb();
    db.$client.close();
    lines.length = 0;
    expect(() => afterRestore(db, NOW, log)).not.toThrow();
    expect(lines.join('\n')).toContain('restore.sessions_not_ended');
  });
});
