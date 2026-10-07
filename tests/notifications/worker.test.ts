import { describe, expect, it } from 'vitest';
import { appendAuthEvent } from '@/data/auth';
import { insertEvents } from '@/data/notifications';
import { makeEvent } from '@/domain/notifications';
import { runCycle, runWorker } from '@/notifications/worker';
import { enableAlerts, fakeChannel } from '../helpers/notifications';
import { riskDb } from '../helpers/risk';

const T0 = new Date('2026-03-10T12:00:00.000Z');
const opts = { clock: () => new Date(T0.getTime() + 5000), sleep: async () => undefined };

describe('one worker cycle', () => {
  it('collects what happened since alerts were switched on, then delivers it', async () => {
    const db = riskDb();
    enableAlerts(db, T0);
    appendAuthEvent(db, { kind: 'login_success', now: new Date(T0.getTime() + 1000) });
    const ch = fakeChannel();
    const r = await runCycle(db, ch, opts);
    expect(r.errors).toEqual([]);
    expect(r.collect?.recorded).toBe(1);
    expect(r.deliver?.sent).toBe(1);
    expect(ch.sent).toEqual(['Houcine.Trades (paper): A sign-in succeeded.']);
  });
  it('with the switch OFF it collects nothing and sends nothing', async () => {
    const db = riskDb();
    appendAuthEvent(db, { kind: 'login_success', now: T0 });
    const ch = fakeChannel();
    const r = await runCycle(db, ch, opts);
    expect(r.collect).toBeNull();
    expect(ch.calls).toBe(0);
  });
  it('NEVER throws: a broken database or a channel that throws becomes a short code', async () => {
    const db = riskDb();
    enableAlerts(db, T0);
    insertEvents(
      db,
      [makeEvent({ kind: 'login_success', dedupeKey: 'k', occurredAt: T0.toISOString() })],
      T0,
    );
    const throwing = fakeChannel(new Error('boom https://api.telegram.org/bot1:SECRET/x'));
    const r = await runCycle(db, throwing, opts);
    expect(r.errors).toEqual([]); // a throwing channel is handled inside delivery
    expect(r.deliver?.failed).toBe(1);
    db.$client.exec('DROP TABLE notification_deliveries; DROP TABLE notification_state');
    const broken = await runCycle(db, fakeChannel(), opts);
    expect(broken.errors).toEqual(['collect_failed', 'deliver_failed']);
    expect(JSON.stringify(broken)).not.toContain('SECRET');
  });
});

describe('the worker loop', () => {
  it('runs cycles until it is told to stop (Ctrl+C), and stops at once', async () => {
    const db = riskDb();
    enableAlerts(db, T0);
    const controller = new AbortController();
    let cycles = 0;
    const slept: number[] = [];
    await runWorker({
      db,
      channel: fakeChannel(),
      signal: controller.signal,
      intervalMs: 30_000,
      options: opts,
      sleep: async (ms) => {
        slept.push(ms);
      },
      onCycle: () => {
        cycles += 1;
        if (cycles === 3) controller.abort();
      },
    });
    expect(cycles).toBe(3);
    expect(slept).toEqual([30_000, 30_000]); // it did not wait again after being stopped
  });
  it('does not start a cycle when it is already stopped', async () => {
    const db = riskDb();
    const controller = new AbortController();
    controller.abort();
    let cycles = 0;
    await runWorker({
      db,
      channel: null,
      signal: controller.signal,
      options: opts,
      onCycle: () => void (cycles += 1),
    });
    expect(cycles).toBe(0);
  });
  it('uses 30 seconds between cycles by default', async () => {
    const db = riskDb();
    const controller = new AbortController();
    const slept: number[] = [];
    await runWorker({
      db,
      channel: null,
      signal: controller.signal,
      options: opts,
      sleep: async (ms) => {
        slept.push(ms);
        controller.abort();
      },
    });
    expect(slept).toEqual([30_000]);
  });
});
