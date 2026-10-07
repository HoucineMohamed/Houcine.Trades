import { describe, expect, it } from 'vitest';
import { memoryDb } from '../helpers/db';

const raw = () => memoryDb().$client;

describe('analyst tables: protections in the database itself', () => {
  it('ai_usage rows can be added but never changed or deleted', () => {
    const db = raw();
    db.prepare(
      "INSERT INTO ai_usage (created_at, feature, model, input_tokens, output_tokens, estimated_cost_usd, status) VALUES ('t', 'tutor', 'm', 1, 1, '0.000001', 'ok')",
    ).run();
    expect(() => db.prepare("UPDATE ai_usage SET status = 'ok'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM ai_usage').run()).toThrow(/append-only/);
  });

  it('ai_usage refuses unknown features and statuses and negative tokens', () => {
    const db = raw();
    const insert = (feature: string, status: string, tokens: number) =>
      db
        .prepare(
          "INSERT INTO ai_usage (created_at, feature, model, input_tokens, output_tokens, estimated_cost_usd, status) VALUES ('t', ?, 'm', ?, 0, '0', ?)",
        )
        .run(feature, tokens, status);
    expect(() => insert('hack', 'ok', 1)).toThrow(/CHECK/);
    expect(() => insert('tutor', 'maybe', 1)).toThrow(/CHECK/);
    expect(() => insert('tutor', 'ok', -1)).toThrow(/CHECK/);
    expect(() => insert('tutor', 'ok', 1)).not.toThrow();
  });

  it('ai_reviews rows can be added but never changed or deleted', () => {
    const db = raw();
    db.prepare(
      "INSERT INTO ai_usage (created_at, feature, model, input_tokens, output_tokens, estimated_cost_usd, status) VALUES ('t', 'tutor', 'm', 1, 1, '0', 'ok')",
    ).run();
    db.prepare(
      "INSERT INTO ai_reviews (kind, input_hash, output_json, checks_json, usage_id, model, created_at) VALUES ('tutor', 'h', '{}', '{}', 1, 'm', 't')",
    ).run();
    expect(() => db.prepare("UPDATE ai_reviews SET output_json = '{}'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM ai_reviews').run()).toThrow(/append-only/);
    // and a review must point at a real usage row
    expect(() =>
      db
        .prepare(
          "INSERT INTO ai_reviews (kind, input_hash, output_json, checks_json, usage_id, model, created_at) VALUES ('tutor', 'h', '{}', '{}', 99, 'm', 't')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('ai_settings holds one row (id 1), only 0/1 consent, and cannot be deleted', () => {
    const db = raw();
    const insert = (id: number, consent: number) =>
      db
        .prepare(
          "INSERT INTO ai_settings (id, consent, caps_json, updated_at) VALUES (?, ?, '{}', 't')",
        )
        .run(id, consent);
    expect(() => insert(2, 0)).toThrow(/CHECK/);
    expect(() => insert(1, 2)).toThrow(/CHECK/);
    expect(() => insert(1, 0)).not.toThrow();
    expect(() => db.prepare('DELETE FROM ai_settings').run()).toThrow(/cannot be deleted/);
  });
});
