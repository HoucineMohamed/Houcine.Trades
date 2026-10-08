import { z } from 'zod';
import { ValidationError, type ValidationIssue } from '../errors';
import { DAY_MS } from '../risk/time';
import type { NotificationEvent } from './events';
import { FILTER_EXEMPT_KINDS } from './events';
import {
  NOTIFICATION_CATEGORIES,
  SEVERITIES,
  severityRank,
  type NotificationCategory,
  type Severity,
} from './kinds';

/**
 * Notification settings. Same idea as the risk limits: making alerts LOUDER (switching a category
 * on, lowering the minimum severity) applies at once; making them QUIETER (switching a category
 * off, raising the minimum severity) needs a fresh code and takes effect after 24 hours, and can
 * be cancelled at once by asking for the louder setting again. Critical events are never held
 * back by these settings.
 */

export const QUIET_DELAY_MS = DAY_MS;

export interface NotificationSettings {
  categories: Record<NotificationCategory, boolean>;
  minSeverity: Severity;
}

export const SETTINGS_DEFAULTS: Readonly<NotificationSettings> = {
  categories: { risk: true, security: true, analyst: true, system: true },
  minSeverity: 'info',
};

const settingsSchema = z.strictObject({
  categories: z.strictObject({
    risk: z.boolean(),
    security: z.boolean(),
    analyst: z.boolean(),
    system: z.boolean(),
  }),
  minSeverity: z.enum(SEVERITIES),
});

export type ParsedSettings =
  { ok: true; settings: NotificationSettings } | { ok: false; problem: string };

export function parseSettings(categoriesJson: string, minSeverity: string): ParsedSettings {
  let categories: unknown;
  try {
    categories = JSON.parse(categoriesJson);
  } catch {
    return { ok: false, problem: 'the stored category switches are not readable' };
  }
  const r = settingsSchema.safeParse({ categories, minSeverity });
  return r.success
    ? { ok: true, settings: r.data }
    : { ok: false, problem: 'the stored notification settings are not valid' };
}

// ---- pending (delayed) quieting ---------------------------------------------------------------------

export interface PendingValue<T> {
  value: T;
  requestedAt: string;
  effectiveAt: string;
}
export interface PendingSettings {
  categories: Partial<Record<NotificationCategory, PendingValue<boolean>>>;
  minSeverity?: PendingValue<Severity>;
}

const pendingEntry = <T extends z.ZodType>(v: T) =>
  z.strictObject({ value: v, requestedAt: z.string(), effectiveAt: z.string() });
const pendingSchema = z.strictObject({
  categories: z.strictObject({
    risk: pendingEntry(z.boolean()).optional(),
    security: pendingEntry(z.boolean()).optional(),
    analyst: pendingEntry(z.boolean()).optional(),
    system: pendingEntry(z.boolean()).optional(),
  }),
  minSeverity: pendingEntry(z.enum(SEVERITIES)).optional(),
});

export type ParsedPending = { ok: true; pending: PendingSettings } | { ok: false; problem: string };

export function parsePending(text: string | null | undefined): ParsedPending {
  if (text === null || text === undefined || text === '' || text === '{}') {
    return { ok: true, pending: { categories: {} } };
  }
  try {
    const r = pendingSchema.safeParse(JSON.parse(text));
    if (!r.success) return { ok: false, problem: 'the stored pending changes are not valid' };
    for (const e of [...Object.values(r.data.categories), r.data.minSeverity]) {
      if (e && Number.isNaN(Date.parse(e.effectiveAt))) {
        return { ok: false, problem: 'a pending change has an unreadable time' };
      }
    }
    return { ok: true, pending: r.data as PendingSettings };
  } catch {
    return { ok: false, problem: 'the stored pending changes are not readable' };
  }
}

export interface SettingsChange {
  active: NotificationSettings;
  pending: PendingSettings;
  applied: string[];
  /** Quieter changes waiting for their time (these need a fresh code). */
  deferred: { what: string; effectiveAt: string }[];
  cancelled: string[];
  unchanged: string[];
}

export function requestSettingsChange(
  active: NotificationSettings,
  pending: PendingSettings,
  requested: { categories?: Partial<Record<NotificationCategory, boolean>>; minSeverity?: string },
  now: Date,
): SettingsChange {
  const issues: ValidationIssue[] = [];
  const nextActive: NotificationSettings = {
    categories: { ...active.categories },
    minSeverity: active.minSeverity,
  };
  const nextPending: PendingSettings = {
    categories: { ...pending.categories },
    ...(pending.minSeverity ? { minSeverity: pending.minSeverity } : {}),
  };
  const out: SettingsChange = {
    active: nextActive,
    pending: nextPending,
    applied: [],
    deferred: [],
    cancelled: [],
    unchanged: [],
  };
  const effectiveAt = new Date(now.getTime() + QUIET_DELAY_MS).toISOString();

  for (const [key, value] of Object.entries(requested.categories ?? {})) {
    if (
      !(NOTIFICATION_CATEGORIES as readonly string[]).includes(key) ||
      typeof value !== 'boolean'
    ) {
      issues.push({ field: key, message: 'is not a notification category switch' });
      continue;
    }
    const cat = key as NotificationCategory;
    const current = active.categories[cat];
    const waiting = nextPending.categories[cat];
    if (value === current) {
      if (waiting) {
        delete nextPending.categories[cat];
        out.cancelled.push(`category ${cat}`);
      } else out.unchanged.push(`category ${cat}`);
    } else if (value) {
      nextActive.categories[cat] = true; // louder: now
      if (waiting) {
        delete nextPending.categories[cat];
        out.cancelled.push(`category ${cat}`);
      }
      out.applied.push(`category ${cat} on`);
    } else if (waiting && waiting.value === false) {
      out.deferred.push({ what: `category ${cat} off`, effectiveAt: waiting.effectiveAt });
    } else {
      nextPending.categories[cat] = { value: false, requestedAt: now.toISOString(), effectiveAt };
      out.deferred.push({ what: `category ${cat} off`, effectiveAt });
    }
  }

  if (requested.minSeverity !== undefined) {
    if (!(SEVERITIES as readonly string[]).includes(requested.minSeverity)) {
      issues.push({ field: 'minSeverity', message: 'is not a severity' });
    } else {
      const want = requested.minSeverity as Severity;
      const cur = active.minSeverity;
      const waiting = nextPending.minSeverity;
      if (want === cur) {
        if (waiting) {
          delete nextPending.minSeverity;
          out.cancelled.push('minimum severity');
        } else out.unchanged.push('minimum severity');
      } else if (severityRank(want) < severityRank(cur)) {
        nextActive.minSeverity = want; // louder: now
        if (waiting) {
          delete nextPending.minSeverity;
          out.cancelled.push('minimum severity');
        }
        out.applied.push(`minimum severity ${want}`);
      } else if (waiting && waiting.value === want) {
        out.deferred.push({ what: `minimum severity ${want}`, effectiveAt: waiting.effectiveAt });
      } else {
        nextPending.minSeverity = { value: want, requestedAt: now.toISOString(), effectiveAt };
        out.deferred.push({ what: `minimum severity ${want}`, effectiveAt });
      }
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return out;
}

/** The settings in force at `now`: the active ones plus every pending change whose time has come. */
export function settleSettings(
  active: NotificationSettings,
  pending: PendingSettings,
  now: Date,
): { settings: NotificationSettings; stillPending: PendingSettings; becameEffective: string[] } {
  const settings: NotificationSettings = {
    categories: { ...active.categories },
    minSeverity: active.minSeverity,
  };
  const stillPending: PendingSettings = { categories: {} };
  const became: string[] = [];
  const due = (e: { effectiveAt: string }) => Date.parse(e.effectiveAt) <= now.getTime();
  for (const cat of NOTIFICATION_CATEGORIES) {
    const p = pending.categories[cat];
    if (!p) continue;
    if (due(p)) {
      settings.categories[cat] = p.value;
      became.push(`category ${cat} ${p.value ? 'on' : 'off'}`);
    } else stillPending.categories[cat] = p;
  }
  if (pending.minSeverity) {
    if (due(pending.minSeverity)) {
      settings.minSeverity = pending.minSeverity.value;
      became.push(`minimum severity ${pending.minSeverity.value}`);
    } else stillPending.minSeverity = pending.minSeverity;
  }
  return { settings, stillPending, becameEffective: became };
}

/** Does this event pass the category and severity settings? Critical events always do. */
export function passesSettings(
  event: Pick<NotificationEvent, 'kind' | 'category' | 'severity'>,
  settings: NotificationSettings,
): boolean {
  if (FILTER_EXEMPT_KINDS.includes(event.kind)) return true;
  if (event.severity === 'critical') return true;
  return (
    settings.categories[event.category] &&
    severityRank(event.severity) >= severityRank(settings.minSeverity)
  );
}
