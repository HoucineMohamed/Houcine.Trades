import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase } from '@/data/client';
import { EVENT_KINDS } from '@/domain/notifications';
import { memoryDb } from '../helpers/db';

/**
 * Migration 0006 REBUILDS notification_events (and its child notification_deliveries) to accept the
 * new system kinds, and adds the append-only backup_runs table. The rebuild must keep every row and
 * id, keep the foreign key, and re-create the append-only triggers.
 */
const DRIZZLE = path.resolve(import.meta.dirname, '..', '..', 'drizzle');

function folderUpTo(lastTag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-migrations-'));
  fs.cpSync(DRIZZLE, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.slice(
    0,
    journal.entries.findIndex((e) => e.tag === lastTag) + 1,
  );
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe('migration 0006 (hosting) keeps the notification outbox intact', () => {
  it('preserves events and deliveries with their ids, stays append-only, accepts the new kinds', () => {
    const old = folderUpTo('0005_notifications');
    try {
      const db = createDatabase(':memory:');
      migrateDatabase(db, old);
      const raw = db.$client;
      const ev = (key: string, kind = 'login_success') =>
        raw
          .prepare(
            "INSERT INTO notification_events (kind, category, severity, dedupe_key, occurred_at, created_at) VALUES (?, 'security', 'info', ?, 't', 't')",
          )
          .run(kind, key);
      ev('a');
      ev('b');
      ev('c', 'backup_failed');
      const del = (event: number, status: string, code: string | null) =>
        raw
          .prepare(
            "INSERT INTO notification_deliveries (event_id, channel, status, at, error_code) VALUES (?, 'fake', ?, 't', ?)",
          )
          .run(event, status, code);
      del(1, 'sending', null);
      del(1, 'failed', 'timeout');
      del(2, 'sent', null);
      expect(() => ev('x', 'backup_succeeded')).toThrow(/CHECK/); // not yet allowed before 0006
      const before = {
        events: raw.prepare('SELECT * FROM notification_events ORDER BY id').all(),
        deliveries: raw.prepare('SELECT * FROM notification_deliveries ORDER BY id').all(),
      };

      migrateDatabase(db); // applies 0006

      expect(raw.prepare('SELECT * FROM notification_events ORDER BY id').all()).toEqual(
        before.events,
      );
      expect(raw.prepare('SELECT * FROM notification_deliveries ORDER BY id').all()).toEqual(
        before.deliveries,
      );
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(raw.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      // ids keep counting from where they were
      expect(ev('d', 'backup_succeeded').lastInsertRowid).toBe(4);
      for (const kind of EVENT_KINDS) {
        expect(() => ev(`k-${kind}`, kind), kind).not.toThrow();
      }
      expect(() => ev('bad', 'made_up')).toThrow(/CHECK/);
      // still append-only, still tied to a real event
      expect(() => raw.prepare("UPDATE notification_events SET severity = 'info'").run()).toThrow(
        /append-only/,
      );
      expect(() => raw.prepare('DELETE FROM notification_events').run()).toThrow(/append-only/);
      expect(() => raw.prepare("UPDATE notification_deliveries SET status = 'sent'").run()).toThrow(
        /append-only/,
      );
      expect(() => raw.prepare('DELETE FROM notification_deliveries').run()).toThrow(/append-only/);
      expect(() => del(9999, 'sent', null)).toThrow(/FOREIGN KEY/);
      expect(() => ev('a')).toThrow(/UNIQUE/); // the dedupe key index came back
    } finally {
      fs.rmSync(old, { recursive: true, force: true });
    }
  });
});

describe('backup_runs', () => {
  const add = (raw: ReturnType<typeof memoryDb>['$client'], sql: string, ...args: unknown[]) =>
    raw.prepare(sql).run(...args);
  const OK =
    "INSERT INTO backup_runs (kind, outcome, started_at, finished_at, object_key, size_bytes, sha256) VALUES (?, 'ok', 't', 't', 'k', 1, 'h')";
  const FAIL =
    "INSERT INTO backup_runs (kind, outcome, started_at, finished_at, error_code) VALUES ('daily', 'failed', 't', 't', ?)";

  it('is append-only, and a failure must carry a short code (never free text)', () => {
    const raw = memoryDb().$client;
    expect(() => add(raw, OK, 'daily')).not.toThrow();
    expect(() => add(raw, FAIL, 'upload_failed')).not.toThrow();
    expect(() => add(raw, FAIL, 'https://s3.example/bucket?sig=SECRET')).toThrow(/CHECK/);
    expect(() => add(raw, FAIL, null)).toThrow(/CHECK/);
    expect(() => add(raw, OK, 'hourly')).toThrow(/CHECK/);
    expect(() => raw.prepare("UPDATE backup_runs SET kind = 'manual'").run()).toThrow(
      /append-only/,
    );
    expect(() => raw.prepare('DELETE FROM backup_runs').run()).toThrow(/append-only/);
  });
  it('a success needs its object key and checksum', () => {
    const raw = memoryDb().$client;
    expect(() =>
      add(
        raw,
        "INSERT INTO backup_runs (kind, outcome, started_at, finished_at) VALUES ('daily', 'ok', 't', 't')",
      ),
    ).toThrow(/CHECK/);
  });
  it('has no column that could hold a key, secret or content', () => {
    const raw = memoryDb().$client;
    const cols = (raw.prepare('PRAGMA table_info(backup_runs)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(
      cols.filter((c) => /secret|token|password|content|body|url|key_material/i.test(c)),
    ).toEqual([]);
  });
});
