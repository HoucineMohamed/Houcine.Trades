import { and, asc, desc, eq, gte, inArray, lt, ne, notInArray, sql } from 'drizzle-orm';
import { assertFreshAuth, type FreshAuth } from '@/domain/auth/stepup';
import { ValidationError } from '@/domain/errors';
import {
  EXPIRED_LOOKBACK_MS,
  HOUR_MS,
  itemStatus,
  makeEvent,
  NOTIFY_LIMITS,
  parsePending,
  parseSettings,
  passesSettings,
  planBatch,
  requestSettingsChange,
  settleSettings,
  SETTINGS_DEFAULTS,
  type AttemptRecord,
  type ChannelName,
  type DeliveryStatus,
  type ErrorCode,
  type HealthInput,
  type ItemStatus,
  type NotificationEvent,
  type NotificationSettings,
  type OutboxItem,
  type PendingSettings,
  type SettingsChange,
} from '@/domain/notifications';
import { appendAuthEvent } from './auth';
import type { Db, Reader, Writer } from './client';
import {
  aiUsage,
  authEvents,
  notificationDeliveries,
  notificationEvents,
  notificationSettings,
  notificationState,
  riskEvents,
  riskVerdicts,
  type NotificationEventRow,
} from './schema';

/**
 * Notification data access: settings, the outbox (events and delivery attempts), the collector's
 * bookkeeping. It only LOADS and STORES; every decision (derived events, levels, ceilings, backoff,
 * what a message says) is made by the pure code in src/domain/notifications. Nothing here talks to
 * the network, and nothing in the trade, halt or login code calls anything here.
 */

export interface ActorMeta {
  sessionId?: number;
  ip?: string;
  userAgent?: string;
}

// ---- settings -----------------------------------------------------------------------------------------

export interface NotificationSettingsView {
  /** "Send alerts to Telegram". OFF unless the stored row says exactly 1. */
  master: boolean;
  consentAt: string | null;
  active: NotificationSettings | null;
  /** The settings in force now (active + quieter changes whose 24 hours passed). */
  effective: NotificationSettings | null;
  pending: PendingSettings;
  problem: string | null;
  updatedAt: string | null;
}

export function getNotificationSettings(
  db: Reader,
  now: Date = new Date(),
): NotificationSettingsView {
  const row = db.select().from(notificationSettings).where(eq(notificationSettings.id, 1)).get();
  if (!row) {
    return {
      master: false,
      consentAt: null,
      active: structuredClone(SETTINGS_DEFAULTS) as NotificationSettings,
      effective: structuredClone(SETTINGS_DEFAULTS) as NotificationSettings,
      pending: { categories: {} },
      problem: null,
      updatedAt: null,
    };
  }
  const base = { master: row.master === 1, consentAt: row.consentAt, updatedAt: row.updatedAt };
  const active = parseSettings(row.categoriesJson, row.minSeverity);
  const pending = parsePending(row.pendingJson);
  if (!active.ok)
    return {
      ...base,
      active: null,
      effective: null,
      pending: { categories: {} },
      problem: active.problem,
    };
  if (!pending.ok) {
    return {
      ...base,
      active: active.settings,
      effective: null,
      pending: { categories: {} },
      problem: pending.problem,
    };
  }
  const settled = settleSettings(active.settings, pending.pending, now);
  return {
    ...base,
    active: active.settings,
    effective: settled.settings,
    pending: settled.stillPending,
    problem: null,
  };
}

function writeSettings(
  tx: Writer,
  v: {
    master: boolean;
    consentAt: string | null;
    settings: NotificationSettings;
    pending: PendingSettings;
  },
  now: Date,
): void {
  const row = {
    id: 1,
    master: v.master ? 1 : 0,
    consentAt: v.consentAt,
    categoriesJson: JSON.stringify(v.settings.categories),
    minSeverity: v.settings.minSeverity,
    pendingJson: JSON.stringify(v.pending),
    updatedAt: now.toISOString(),
  };
  tx.insert(notificationSettings)
    .values(row)
    .onConflictDoUpdate({
      target: notificationSettings.id,
      set: {
        master: row.master,
        consentAt: row.consentAt,
        categoriesJson: row.categoriesJson,
        minSeverity: row.minSeverity,
        pendingJson: row.pendingJson,
        updatedAt: row.updatedAt,
      },
    })
    .run();
}

const logChange = (
  tx: Writer,
  kind: 'notifications_on' | 'notifications_off' | 'notifications_settings_changed',
  detail: string,
  now: Date,
  meta: ActorMeta,
  auth: FreshAuth | null,
) =>
  appendAuthEvent(tx, {
    kind,
    now,
    sessionId: meta.sessionId ?? (auth ? auth.sessionId : null),
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail,
  });

/** Writes a note in the authentication log that the channel (token / chat) was changed. */
export function logChannelChange(
  db: Db,
  detail: 'channel_paired' | 'channel_token_changed',
  now: Date = new Date(),
): void {
  db.transaction((tx) => logChange(tx, 'notifications_settings_changed', detail, now, {}, null));
}

/**
 * The master switch. ON and OFF BOTH need a fresh authenticator code and are logged. ON also stores
 * the consent time and the collector baseline (so only events from now on are announced). OFF takes
 * effect at once and records ONE final notice ("Alerts were switched off") in the outbox.
 */
export function setNotificationsMaster(
  db: Db,
  on: boolean,
  auth: FreshAuth | null,
  now: Date = new Date(),
  meta: ActorMeta = {},
  baseline: Record<string, string> = {},
): void {
  assertFreshAuth(auth, now, on ? 'turning on alerts' : 'turning off alerts');
  db.transaction(
    (tx) => {
      const view = getNotificationSettings(tx, now);
      if (on) {
        if (view.problem !== null || view.effective === null) {
          throw new ValidationError([
            {
              field: '',
              message: `The stored notification settings are corrupt (${view.problem}), so alerts cannot be turned on.`,
            },
          ]);
        }
        // Already on: nothing to do. (Re-baselining would skip events that were not collected yet.)
        if (view.master) return;
        writeSettings(
          tx,
          {
            master: true,
            consentAt: now.toISOString(),
            settings: view.effective,
            pending: view.pending,
          },
          now,
        );
        writeStates(
          tx,
          { ...baseline, [HEARTBEAT_KEY]: now.toISOString(), [BASELINE_AT_KEY]: now.toISOString() },
          now,
        );
        logChange(tx, 'notifications_on', 'master_switch', now, meta, auth);
        return;
      }
      if (!view.master) return; // already off: nothing to announce or log
      if (view.problem !== null || view.effective === null) {
        tx.update(notificationSettings)
          .set({ master: 0, updatedAt: now.toISOString() })
          .where(eq(notificationSettings.id, 1))
          .run();
      } else {
        writeSettings(
          tx,
          {
            master: false,
            consentAt: view.consentAt,
            settings: view.effective,
            pending: view.pending,
          },
          now,
        );
      }
      insertEvents(
        tx,
        [
          makeEvent({
            kind: 'notifications_switched_off',
            dedupeKey: `switched_off:${now.toISOString()}`,
            occurredAt: now.toISOString(),
          }),
        ],
        now,
      );
      logChange(
        tx,
        'notifications_off',
        view.problem !== null ? 'master_switch_settings_corrupt' : 'master_switch',
        now,
        meta,
        auth,
      );
    },
    { behavior: 'immediate' },
  );
}

/**
 * Category switches and the minimum severity. Louder settings apply now; quieter ones need a fresh
 * code and wait 24 hours (cancel them by asking for the louder setting). Every change is logged.
 */
export function updateNotificationSettings(
  db: Db,
  requested: { categories?: Record<string, boolean>; minSeverity?: string },
  auth: FreshAuth | null,
  now: Date = new Date(),
  meta: ActorMeta = {},
): SettingsChange {
  return db.transaction(
    (tx) => {
      const view = getNotificationSettings(tx, now);
      if (view.problem !== null || view.effective === null) {
        throw new ValidationError([
          {
            field: '',
            message: `The stored notification settings are corrupt (${view.problem}). They cannot be edited.`,
          },
        ]);
      }
      const result = requestSettingsChange(view.effective, view.pending, requested, now);
      if (result.deferred.length > 0)
        assertFreshAuth(auth, now, 'switching off or quieting alerts');
      writeSettings(
        tx,
        {
          master: view.master,
          consentAt: view.consentAt,
          settings: result.active,
          pending: result.pending,
        },
        now,
      );
      const parts = [
        result.applied.length > 0 ? 'louder_now' : null,
        result.deferred.length > 0 ? 'quieter_requested' : null,
        result.cancelled.length > 0 ? 'pending_cancelled' : null,
      ].filter((p): p is string => p !== null);
      if (parts.length > 0)
        logChange(tx, 'notifications_settings_changed', parts.join('+'), now, meta, auth);
      return result;
    },
    { behavior: 'immediate' },
  );
}

// ---- collector bookkeeping ---------------------------------------------------------------------------------

export const HEARTBEAT_KEY = 'hb:cycle';
export const BASELINE_AT_KEY = 'baseline:at';
const LAST_PROBLEMS_KEY = 'last:problems';

export function readState(db: Reader, key: string): string | null {
  return (
    db.select().from(notificationState).where(eq(notificationState.key, key)).get()?.valueJson ??
    null
  );
}

export function readAllState(db: Reader): Record<string, string> {
  return Object.fromEntries(
    db
      .select()
      .from(notificationState)
      .all()
      .map((r) => [r.key, r.valueJson]),
  );
}

export function writeStates(tx: Writer, entries: Record<string, string>, now: Date): void {
  for (const [key, valueJson] of Object.entries(entries)) {
    tx.insert(notificationState)
      .values({ key, valueJson, updatedAt: now.toISOString() })
      .onConflictDoUpdate({
        target: notificationState.key,
        set: { valueJson, updatedAt: now.toISOString() },
      })
      .run();
  }
}

/** The newest id in each log the collector reads (the starting point when alerts are switched on). */
export function currentMaxIds(db: Reader): {
  risk: number;
  verdict: number;
  auth: number;
  usage: number;
} {
  const max = (q: { m: number | null } | undefined) => q?.m ?? 0;
  return {
    risk: max(
      db
        .select({ m: sql<number | null>`max(${riskEvents.id})` })
        .from(riskEvents)
        .get(),
    ),
    verdict: max(
      db
        .select({ m: sql<number | null>`max(${riskVerdicts.id})` })
        .from(riskVerdicts)
        .get(),
    ),
    auth: max(
      db
        .select({ m: sql<number | null>`max(${authEvents.id})` })
        .from(authEvents)
        .get(),
    ),
    usage: max(
      db
        .select({ m: sql<number | null>`max(${aiUsage.id})` })
        .from(aiUsage)
        .get(),
    ),
  };
}

// ---- events (the outbox) ------------------------------------------------------------------------------------

/** Records events. An event whose dedupe key exists is skipped. Returns how many were new. */
export function insertEvents(tx: Writer, events: readonly NotificationEvent[], now: Date): number {
  let added = 0;
  for (const e of events) {
    const r = tx
      .insert(notificationEvents)
      .values({
        kind: e.kind,
        category: e.category,
        severity: e.severity,
        dedupeKey: e.dedupeKey,
        accountId: e.accountId,
        level: e.level,
        count: e.count,
        occurredAt: e.occurredAt,
        createdAt: now.toISOString(),
      })
      .onConflictDoNothing()
      .run();
    added += r.changes;
  }
  return added;
}

function toEvent(row: NotificationEventRow): NotificationEvent {
  return {
    kind: row.kind,
    category: row.category,
    severity: row.severity,
    dedupeKey: row.dedupeKey,
    occurredAt: row.occurredAt,
    accountId: row.accountId,
    level: row.level === 50 || row.level === 80 || row.level === 100 ? row.level : null,
    count: row.count,
  };
}

function attemptsFor(db: Reader, eventIds: number[]): Map<number, AttemptRecord[]> {
  const map = new Map<number, AttemptRecord[]>();
  if (eventIds.length === 0) return map;
  const rows = db
    .select()
    .from(notificationDeliveries)
    .where(inArray(notificationDeliveries.eventId, eventIds))
    .orderBy(asc(notificationDeliveries.id))
    .all();
  for (const r of rows) {
    const list = map.get(r.eventId) ?? [];
    list.push({ status: r.status, at: r.at, retryAfterS: r.retryAfterS });
    map.set(r.eventId, list);
  }
  return map;
}

/** Every event that was never sent and is not older than the maximum age, with its attempts. */
export function loadOutbox(db: Reader, now: Date): OutboxItem[] {
  const cutoff = new Date(now.getTime() - NOTIFY_LIMITS.maxAgeMs).toISOString();
  const sentIds = db
    .select({ id: notificationDeliveries.eventId })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.status, 'sent'));
  const rows = db
    .select()
    .from(notificationEvents)
    .where(
      and(gte(notificationEvents.occurredAt, cutoff), notInArray(notificationEvents.id, sentIds)),
    )
    .orderBy(asc(notificationEvents.id))
    .all();
  const attempts = attemptsFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ id: r.id, event: toEvent(r), attempts: attempts.get(r.id) ?? [] }));
}

export function recordAttempt(
  tx: Writer,
  a: {
    eventId: number;
    channel: ChannelName;
    status: DeliveryStatus;
    at: Date;
    errorCode?: ErrorCode | null;
    retryAfterS?: number | null;
  },
): number {
  return tx
    .insert(notificationDeliveries)
    .values({
      eventId: a.eventId,
      channel: a.channel,
      status: a.status,
      at: a.at.toISOString(),
      errorCode: a.errorCode ?? null,
      retryAfterS: a.retryAfterS ?? null,
    })
    .returning({ id: notificationDeliveries.id })
    .get().id;
}

export interface Claimed {
  eventId: number;
  event: NotificationEvent;
}

/**
 * Atomically decides what to send NOW and writes a "sending" attempt for each chosen event, in an
 * IMMEDIATE transaction: the worker and the "Deliver now" button cannot both claim the same event.
 * `allow` is the category / severity / final-notice filter. Events held back by the hourly ceiling
 * stay in the outbox; if any are held and no summary went out this hour, one summary event is made.
 */
export function claimDue(
  db: Db,
  now: Date,
  channel: ChannelName,
  allow: (e: NotificationEvent) => boolean,
): { claimed: Claimed[]; held: number } {
  return db.transaction(
    (tx) => {
      const items = loadOutbox(tx, now).filter((i) => allow(i.event));
      const due = items.filter((i) => itemStatus(i, now).status === 'due');
      const sentRows = tx
        .select({ kind: notificationEvents.kind, severity: notificationEvents.severity })
        .from(notificationDeliveries)
        .innerJoin(notificationEvents, eq(notificationDeliveries.eventId, notificationEvents.id))
        .where(
          and(
            eq(notificationDeliveries.status, 'sent'),
            gte(notificationDeliveries.at, new Date(now.getTime() - HOUR_MS).toISOString()),
          ),
        )
        .all();
      const plan = planBatch({
        due,
        sentLastHour: sentRows,
        summarySentLastHour: sentRows.some((r) => r.kind === 'flood_summary'),
      });
      const send = [...plan.send];
      if (plan.summaryCount !== null) {
        const hourKey = now.toISOString().slice(0, 13);
        const summary = makeEvent({
          kind: 'flood_summary',
          dedupeKey: `summary:${hourKey}`,
          occurredAt: now.toISOString(),
          count: plan.summaryCount,
        });
        if (insertEvents(tx, [summary], now) === 1) {
          const row = tx
            .select()
            .from(notificationEvents)
            .where(eq(notificationEvents.dedupeKey, summary.dedupeKey))
            .get();
          if (row) send.push({ id: row.id, event: toEvent(row), attempts: [] });
        }
      }
      for (const s of send)
        recordAttempt(tx, { eventId: s.id, channel, status: 'sending', at: now });
      return {
        claimed: send.map((s) => ({ eventId: s.id, event: s.event })),
        held: plan.held.length,
      };
    },
    { behavior: 'immediate' },
  );
}

// ---- display and health ---------------------------------------------------------------------------------------

export interface EventListRow {
  id: number;
  event: NotificationEvent;
  status: ItemStatus | 'held_by_settings';
  failures: number;
  lastErrorCode: ErrorCode | null;
  lastAttemptAt: string | null;
  nextAt: string | null;
}

/** Newest first, with the state derived from the attempt log. */
export function listRecentEvents(
  db: Reader,
  now: Date,
  limit = 50,
  allow: (e: NotificationEvent) => boolean = () => true,
): EventListRow[] {
  const rows = db
    .select()
    .from(notificationEvents)
    .orderBy(desc(notificationEvents.id))
    .limit(limit)
    .all();
  const attempts = attemptsFor(
    db,
    rows.map((r) => r.id),
  );
  const lastErrors = new Map<number, ErrorCode | null>();
  const lastAt = new Map<number, string>();
  if (rows.length > 0) {
    for (const r of db
      .select()
      .from(notificationDeliveries)
      .where(
        inArray(
          notificationDeliveries.eventId,
          rows.map((x) => x.id),
        ),
      )
      .orderBy(asc(notificationDeliveries.id))
      .all()) {
      lastErrors.set(
        r.eventId,
        r.status === 'failed' ? r.errorCode : (lastErrors.get(r.eventId) ?? null),
      );
      lastAt.set(r.eventId, r.at);
    }
  }
  return rows.map((r) => {
    const event = toEvent(r);
    const item: OutboxItem = { id: r.id, event, attempts: attempts.get(r.id) ?? [] };
    const st = itemStatus(item, now);
    return {
      id: r.id,
      event,
      status:
        st.status !== 'sent' && st.status !== 'expired' && !allow(event)
          ? 'held_by_settings'
          : st.status,
      failures: st.failures,
      lastErrorCode: lastErrors.get(r.id) ?? null,
      lastAttemptAt: lastAt.get(r.id) ?? null,
      nextAt: st.nextAt,
    };
  });
}

/** What the header indicator needs: the latest attempts and how long an event has been failing. */
export function getHealthInput(
  db: Reader,
  now: Date,
): { recentStatuses: DeliveryStatus[]; oldestFailingAgeMs: number | null } {
  const recent = db
    .select({ status: notificationDeliveries.status })
    .from(notificationDeliveries)
    .where(ne(notificationDeliveries.status, 'sending')) // the claim rows are not results
    .orderBy(desc(notificationDeliveries.id))
    .limit(3)
    .all()
    .map((r) => r.status);
  let oldest: number | null = null;
  for (const item of loadOutbox(db, now)) {
    const st = itemStatus(item, now);
    if (st.failures > 0 && (st.status === 'due' || st.status === 'waiting')) {
      const age = now.getTime() - Date.parse(item.event.occurredAt);
      oldest = oldest === null ? age : Math.max(oldest, age);
    }
  }
  return { recentStatuses: recent, oldestFailingAgeMs: oldest };
}

/** The latest event of a kind that was recorded (used by the page to show "last test"). */
export function lastEventAt(db: Reader, kind: NotificationEvent['kind']): string | null {
  return (
    db
      .select({ at: notificationEvents.createdAt })
      .from(notificationEvents)
      .where(eq(notificationEvents.kind, kind))
      .orderBy(desc(notificationEvents.id))
      .limit(1)
      .get()?.at ?? null
  );
}

/** Looks an event up by its dedupe key. */
export function findEventByKey(db: Reader, dedupeKey: string): NotificationEventRow | undefined {
  return db
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.dedupeKey, dedupeKey))
    .get();
}

/** The worker (or "Deliver now") writes this after every cycle: proof it ran, and what it could not do. */
export function writeHeartbeat(db: Db, now: Date, problems: readonly string[]): void {
  db.transaction((tx) =>
    writeStates(
      tx,
      {
        [HEARTBEAT_KEY]: now.toISOString(),
        [LAST_PROBLEMS_KEY]: JSON.stringify([...new Set(problems)].slice(0, 20)),
      },
      now,
    ),
  );
}

function readProblems(db: Reader): string[] {
  try {
    const parsed: unknown = JSON.parse(readState(db, LAST_PROBLEMS_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : ['unreadable'];
  } catch {
    return ['unreadable'];
  }
}

/** Events of the last 7 days that were never sent and are now too old to be sent (and not filtered by the settings). */
export function countExpiredUnsent(
  db: Reader,
  now: Date,
  allow: (e: NotificationEvent) => boolean,
): number {
  const oldest = new Date(now.getTime() - EXPIRED_LOOKBACK_MS).toISOString();
  const newest = new Date(now.getTime() - NOTIFY_LIMITS.maxAgeMs).toISOString();
  const sentIds = db
    .select({ id: notificationDeliveries.eventId })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.status, 'sent'));
  return db
    .select()
    .from(notificationEvents)
    .where(
      and(
        gte(notificationEvents.occurredAt, oldest),
        lt(notificationEvents.occurredAt, newest),
        notInArray(notificationEvents.id, sentIds),
      ),
    )
    .all()
    .map(toEvent)
    .filter(allow).length;
}

/**
 * Everything the header and the page need to say whether alerts are getting through. Never throws:
 * if the health cannot be read it returns null, and the caller must show "status unknown", never "fine".
 */
export function loadHealth(
  db: Reader,
  now: Date,
  channelReady: boolean,
): { input: HealthInput; problems: string[] } | null {
  try {
    const settings = getNotificationSettings(db, now);
    const effective = settings.effective;
    const base = getHealthInput(db, now);
    const hb = readState(db, HEARTBEAT_KEY);
    const hbMs = hb ? Date.parse(hb) : Number.NaN;
    const problems = readProblems(db);
    return {
      problems,
      input: {
        masterOn: settings.master,
        channelReady,
        recentStatuses: base.recentStatuses,
        oldestFailingAgeMs: base.oldestFailingAgeMs,
        heartbeatAgeMs: Number.isFinite(hbMs) ? Math.max(0, now.getTime() - hbMs) : null,
        settingsProblem: settings.problem !== null,
        expiredUnsent: effective
          ? countExpiredUnsent(db, now, (e) => passesSettings(e, effective))
          : 0,
        collectorProblems: problems.length,
      },
    };
  } catch {
    return null;
  }
}
