import { and, desc, eq } from 'drizzle-orm';
import type { HaltKind, RiskEventKind } from '@/domain/risk/kinds';
import type { Db, Reader, Writer } from './client';
import { riskEvents, type RiskEventRow } from './schema';

/** The append-only risk event log. Rows can be added, never changed or removed (SQLite triggers). */

export interface NewRiskEvent {
  accountId: number;
  kind: RiskEventKind;
  haltKind?: HaltKind | null;
  tradeId?: number | null;
  reason?: string;
  details?: Record<string, unknown>;
  at: Date;
}

export function appendRiskEvent(tx: Writer, e: NewRiskEvent): RiskEventRow {
  return tx
    .insert(riskEvents)
    .values({
      accountId: e.accountId,
      kind: e.kind,
      haltKind: e.haltKind ?? null,
      tradeId: e.tradeId ?? null,
      reason: e.reason ?? '',
      detailsJson: JSON.stringify(e.details ?? {}),
      createdAt: e.at.toISOString(),
    })
    .returning()
    .get();
}

export function parseDetails(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Newest first. */
export function listRiskEvents(db: Reader, accountId: number, limit = 50): RiskEventRow[] {
  return db
    .select()
    .from(riskEvents)
    .where(eq(riskEvents.accountId, accountId))
    .orderBy(desc(riskEvents.id))
    .limit(limit)
    .all();
}

export function countRiskEvents(db: Db, accountId: number, kind: RiskEventKind): number {
  return db
    .select()
    .from(riskEvents)
    .where(and(eq(riskEvents.accountId, accountId), eq(riskEvents.kind, kind)))
    .all().length;
}
