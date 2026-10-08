import 'server-only';
import type { Writer } from '@/data/client';
import { insertEvents } from '@/data/notifications';
import { makeEvent, type EventKind } from '@/domain/notifications';

/**
 * Hosting events (backup finished or failed, migration applied or failed, restore applied) enter the
 * existing notification outbox as ordinary events with a fixed template. Nothing else is added to the
 * notification code. Best effort: recording an event can never make a backup, a migration or a
 * restore fail.
 */
export function announce(db: Writer, kind: EventKind, dedupeKey: string, now: Date): boolean {
  try {
    insertEvents(db, [makeEvent({ kind, dedupeKey, occurredAt: now.toISOString() })], now);
    return true;
  } catch {
    return false;
  }
}
