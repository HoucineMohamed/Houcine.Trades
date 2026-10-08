import 'server-only';
import type { Db } from '@/data/client';
import { getNotificationSettings, insertEvents } from '@/data/notifications';
import { makeEvent, type EventKind } from '@/domain/notifications';

/**
 * Hosting events (backup finished or failed, migration applied or failed, restore applied) enter the
 * existing notification outbox as ordinary events with a fixed template. Nothing else is added to the
 * notification code.
 *
 * Only while alerts are switched ON (like every other event: only things that happen from the moment
 * alerts are switched on are announced, so a long list of old notices can never flood the phone). The
 * log and the Backups page always show everything.
 *
 * Best effort: recording an event can never make a backup, a migration or a restore fail.
 */
export function announce(db: Db, kind: EventKind, dedupeKey: string, now: Date): boolean {
  try {
    if (!getNotificationSettings(db, now).master) return false;
    insertEvents(db, [makeEvent({ kind, dedupeKey, occurredAt: now.toISOString() })], now);
    return true;
  } catch {
    return false;
  }
}
