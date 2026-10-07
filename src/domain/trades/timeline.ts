import type { TradeStatus } from './types';

/**
 * The life of a trade as a list of steps for the detail page. Pure: it only arranges the
 * timestamps the journal already stores.
 */

export interface TimelineInput {
  status: TradeStatus;
  createdAt: string;
  openedAt: string | null;
  closedAt: string | null;
  closedRecordedAt: string | null;
  updatedAt: string;
}

export interface TimelineStep {
  key: 'created' | 'opened' | 'closed' | 'cancelled';
  label: string;
  /** ISO time, or null for a step that has not happened. */
  at: string | null;
  done: boolean;
  /** Extra plain text, e.g. when a backdated close was recorded. */
  note: string | null;
}

export function tradeTimeline(t: TimelineInput): TimelineStep[] {
  const steps: TimelineStep[] = [
    { key: 'created', label: 'Planned in the journal', at: t.createdAt, done: true, note: null },
  ];
  if (t.status === 'cancelled') {
    steps.push({ key: 'cancelled', label: 'Cancelled', at: t.updatedAt, done: true, note: null });
    return steps;
  }
  const opened = t.status === 'open' || t.status === 'closed';
  steps.push({
    key: 'opened',
    label: 'Opened',
    at: opened ? t.openedAt : null,
    done: opened,
    note: null,
  });
  const closed = t.status === 'closed';
  const backdated =
    closed &&
    t.closedRecordedAt !== null &&
    t.closedAt !== null &&
    t.closedRecordedAt !== t.closedAt;
  steps.push({
    key: 'closed',
    label: 'Closed',
    at: closed ? t.closedAt : null,
    done: closed,
    note: backdated ? `Recorded in the journal at ${t.closedRecordedAt}` : null,
  });
  return steps;
}
