import 'server-only';
import type { Db } from '@/data/client';
import { getNotificationSettings, writeHeartbeat } from '@/data/notifications';
import { NOTIFY_LIMITS } from '@/domain/notifications';
import type { NotificationChannel } from '@/integrations/telegram/types';
import { collectEvents, type CollectReport } from './collector';
import { deliverPending, type DeliveryOptions, type DeliveryReport } from './delivery';

/**
 * One worker cycle: collect new events (only while alerts are ON), then deliver what is pending.
 * NEVER throws: every problem becomes a short code in the report, so a broken channel, a locked
 * database or a bad row can never stop the loop. Module 8 will run this loop as a service.
 */

export interface CycleReport {
  collect: CollectReport | null;
  deliver: DeliveryReport | null;
  /** Short codes of what went wrong (no free text). */
  errors: ('collect_failed' | 'deliver_failed' | 'heartbeat_failed')[];
  /** Every short code worth showing to the owner (collector problems, skipped delivery, storage problems). */
  problems: string[];
}

export async function runCycle(
  db: Db,
  channel: NotificationChannel | null,
  options: DeliveryOptions = {},
): Promise<CycleReport> {
  const clock = options.clock ?? (() => new Date());
  const report: CycleReport = { collect: null, deliver: null, errors: [], problems: [] };
  try {
    if (getNotificationSettings(db, clock()).master) report.collect = collectEvents(db, clock());
  } catch {
    report.errors.push('collect_failed');
  }
  try {
    report.deliver = await deliverPending(db, channel, options);
  } catch {
    report.errors.push('deliver_failed');
  }
  report.problems = [
    ...report.errors,
    ...(report.collect?.problems ?? []),
    ...(report.deliver?.skipped ? [`skipped_${report.deliver.skipped}`] : []),
    ...(report.deliver?.storageProblem ? ['storage_problem'] : []),
  ];
  // Proof that a cycle ran (the header says "worker not running" without it) and what it could not do.
  try {
    writeHeartbeat(db, clock(), report.problems);
  } catch {
    report.errors.push('heartbeat_failed');
    report.problems.push('heartbeat_failed');
  }
  return report;
}

export async function runWorker(input: {
  db: Db;
  channel: NotificationChannel | null;
  signal: AbortSignal;
  intervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onCycle?: (r: CycleReport) => void;
  options?: DeliveryOptions;
}): Promise<void> {
  const interval = input.intervalMs ?? NOTIFY_LIMITS.workerIntervalMs;
  const sleep =
    input.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort); // no listener is left behind after each cycle
          resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
      }));
  const options: DeliveryOptions = { ...input.options, signal: input.signal };
  while (!input.signal.aborted) {
    const r = await runCycle(input.db, input.channel, options);
    try {
      input.onCycle?.(r);
    } catch {
      // a failing logger must never stop the worker
    }
    if (input.signal.aborted) break;
    await sleep(interval, input.signal);
  }
}
