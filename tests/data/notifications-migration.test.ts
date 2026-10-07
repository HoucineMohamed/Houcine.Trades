import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase } from '@/data/client';
import { memoryDb } from '../helpers/db';

/**
 * Migration 0005 REBUILDS auth_events (again) to allow three new event kinds. This proves the
 * rebuild keeps every existing row, keeps the ids counting, and re-creates the protecting triggers.
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

describe('migration 0005 (notifications) keeps the authentication log intact', () => {
  it('preserves rows (including the analyst kinds from 0004), stays append-only, allows the new kinds', () => {
    const old = folderUpTo('0004_analyst');
    try {
      const db = createDatabase(':memory:');
      migrateDatabase(db, old);
      const raw = db.$client;
      const add = (kind: string, detail: string) =>
        raw
          .prepare(
            "INSERT INTO auth_events (kind, created_at, ip, user_agent, detail) VALUES (?, '2026-01-01T00:00:00.000Z', 'direct', 'ua', ?)",
          )
          .run(kind, detail);
      add('login_success', 'x');
      add('ai_consent_on', 'privacy_switch');
      add('owner_created', 'cli');

      migrateDatabase(db); // applies 0005

      expect(raw.prepare('SELECT id, kind, detail FROM auth_events ORDER BY id').all()).toEqual([
        { id: 1, kind: 'login_success', detail: 'x' },
        { id: 2, kind: 'ai_consent_on', detail: 'privacy_switch' },
        { id: 3, kind: 'owner_created', detail: 'cli' },
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
      for (const kind of [
        'notifications_on',
        'notifications_off',
        'notifications_settings_changed',
        'ai_caps_changed',
      ]) {
        expect(() => insert(kind)).not.toThrow();
      }
      expect(() => insert('not_a_kind')).toThrow(/CHECK/);
      expect(raw.prepare('SELECT max(id) AS m FROM auth_events').get()).toEqual({ m: 7 });
    } finally {
      fs.rmSync(old, { recursive: true, force: true });
    }
  });
});

describe('notification tables: protections in the database itself', () => {
  const ev = (raw: ReturnType<typeof memoryDb>['$client'], key = 'k1') =>
    raw
      .prepare(
        "INSERT INTO notification_events (kind, category, severity, dedupe_key, occurred_at, created_at) VALUES ('login_success', 'security', 'info', ?, 't', 't')",
      )
      .run(key);

  it('events: append-only, a dedupe key can be recorded once only, enums and levels are checked', () => {
    const raw = memoryDb().$client;
    ev(raw);
    expect(() => ev(raw)).toThrow(/UNIQUE/);
    expect(() => raw.prepare("UPDATE notification_events SET severity = 'info'").run()).toThrow(
      /append-only/,
    );
    expect(() => raw.prepare('DELETE FROM notification_events').run()).toThrow(/append-only/);
    const bad = (kind: string, level: number | null) =>
      raw
        .prepare(
          "INSERT INTO notification_events (kind, category, severity, dedupe_key, level, occurred_at, created_at) VALUES (?, 'risk', 'info', ?, ?, 't', 't')",
        )
        .run(kind, `x${Math.random()}`, level);
    expect(() => bad('made_up', null)).toThrow(/CHECK/);
    expect(() => bad('daily_loss_usage', 77)).toThrow(/CHECK/);
    expect(() => bad('daily_loss_usage', 80)).not.toThrow();
  });

  it('deliveries: append-only, tied to a real event, short error codes only', () => {
    const raw = memoryDb().$client;
    ev(raw);
    const add = (status: string, code: string | null, event = 1) =>
      raw
        .prepare(
          "INSERT INTO notification_deliveries (event_id, channel, status, at, error_code) VALUES (?, 'fake', ?, 't', ?)",
        )
        .run(event, status, code);
    expect(() => add('failed', 'timeout')).not.toThrow();
    expect(() => add('failed', 'https://api.example/bot123:SECRET/sendMessage')).toThrow(/CHECK/); // free text cannot be stored
    expect(() => add('maybe', null)).toThrow(/CHECK/);
    expect(() => add('sent', null, 99)).toThrow(/FOREIGN KEY/);
    expect(() => raw.prepare("UPDATE notification_deliveries SET status = 'sent'").run()).toThrow(
      /append-only/,
    );
    expect(() => raw.prepare('DELETE FROM notification_deliveries').run()).toThrow(/append-only/);
  });

  it('settings: one row, switch is 0/1, cannot be deleted', () => {
    const raw = memoryDb().$client;
    const ins = (id: number, master: number) =>
      raw
        .prepare(
          "INSERT INTO notification_settings (id, master, categories_json, updated_at) VALUES (?, ?, '{}', 't')",
        )
        .run(id, master);
    expect(() => ins(2, 0)).toThrow(/CHECK/);
    expect(() => ins(1, 2)).toThrow(/CHECK/);
    expect(() => ins(1, 0)).not.toThrow();
    expect(() => raw.prepare('DELETE FROM notification_settings').run()).toThrow(
      /cannot be deleted/,
    );
  });

  it('no table has a column that could hold message text or a secret', () => {
    const raw = memoryDb().$client;
    for (const t of ['notification_events', 'notification_deliveries']) {
      const cols = (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols.filter((c) => /message|text|body|token|chat|url|note|name/i.test(c))).toEqual([]);
    }
  });
});
