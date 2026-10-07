import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase } from '@/data/client';

/**
 * Migration 0004 REBUILDS the auth_events table (to allow three new event kinds). This proves the
 * rebuild keeps every existing row and re-creates the two protecting triggers.
 */

const DRIZZLE = path.resolve(import.meta.dirname, '..', '..', 'drizzle');

function folderUpTo(lastTag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-migrations-'));
  fs.cpSync(DRIZZLE, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const keep = journal.entries.findIndex((e) => e.tag === lastTag) + 1;
  journal.entries = journal.entries.slice(0, keep);
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe('migration 0004 (analyst) keeps the authentication log intact', () => {
  it('preserves existing auth_events rows, keeps them append-only, and allows the new kinds', () => {
    const old = folderUpTo('0003_auth');
    try {
      const db = createDatabase(':memory:');
      migrateDatabase(db, old);
      const raw = db.$client;
      raw
        .prepare(
          "INSERT INTO auth_events (kind, created_at, ip, user_agent, detail) VALUES ('login_success', '2026-01-01T00:00:00.000Z', 'direct', 'ua', 'x')",
        )
        .run();
      raw
        .prepare(
          "INSERT INTO auth_events (kind, created_at, ip, user_agent, detail) VALUES ('owner_created', '2026-01-01T00:00:01.000Z', '', '', 'cli')",
        )
        .run();

      migrateDatabase(db); // applies 0004 on top

      const rows = raw.prepare('SELECT id, kind, detail FROM auth_events ORDER BY id').all();
      expect(rows).toEqual([
        { id: 1, kind: 'login_success', detail: 'x' },
        { id: 2, kind: 'owner_created', detail: 'cli' },
      ]);
      expect(() => raw.prepare("UPDATE auth_events SET detail = 'edited'").run()).toThrow(
        /append-only/,
      );
      expect(() => raw.prepare('DELETE FROM auth_events').run()).toThrow(/append-only/);

      const insert = (kind: string) =>
        raw
          .prepare(
            "INSERT INTO auth_events (kind, created_at) VALUES (?, '2026-02-01T00:00:00.000Z')",
          )
          .run(kind);
      for (const kind of ['ai_consent_on', 'ai_consent_off', 'ai_caps_changed']) {
        expect(() => insert(kind)).not.toThrow();
      }
      expect(() => insert('not_a_kind')).toThrow(/CHECK/);
      // ids keep counting (AUTOINCREMENT survived the rebuild)
      expect(raw.prepare('SELECT max(id) AS m FROM auth_events').get()).toEqual({ m: 5 });
    } finally {
      fs.rmSync(old, { recursive: true, force: true });
    }
  });
});
