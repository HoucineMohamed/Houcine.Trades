import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@/hosting/logger';
import { heartbeatPath } from '@/hosting/health';
import { runHostedWorker } from '@/hosting/worker-main';
import { memoryDb } from '../helpers/db';

let dir: string;
const log = createLogger({ write: () => undefined });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-worker-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('hosted worker', () => {
  it('shows a sign of life from the start and after every cycle, runs the backup check, and closes the database on stop', async () => {
    const db = memoryDb();
    const controller = new AbortController();
    let ticks = 0;
    const seen: boolean[] = [];
    const job = {
      tick: async () => {
        ticks += 1;
        seen.push(fs.existsSync(heartbeatPath(dir)));
        if (ticks === 2) controller.abort();
        return 'ran' as const;
      },
    };
    await runHostedWorker({
      db,
      channel: null,
      signal: controller.signal,
      dataDir: dir,
      backupJob: job,
      log,
      intervalMs: 5,
    });
    expect(ticks).toBe(2);
    expect(seen.every(Boolean)).toBe(true);
    expect(() => db.$client.prepare('SELECT 1').get()).toThrow(); // closed
  });

  it('waits for a backup that is still running when it is told to stop', async () => {
    const db = memoryDb();
    const controller = new AbortController();
    let finished = false;
    const job = {
      tick: async () => {
        controller.abort();
        await new Promise((r) => setTimeout(r, 60));
        finished = true;
        return 'ran' as const;
      },
    };
    await runHostedWorker({
      db,
      channel: null,
      signal: controller.signal,
      dataDir: dir,
      backupJob: job,
      log,
      intervalMs: 5,
      backupWaitMs: 2000,
    });
    expect(finished).toBe(true);
  });

  it('does not wait forever for a stuck backup', async () => {
    const db = memoryDb();
    const controller = new AbortController();
    const job = {
      tick: () => {
        controller.abort();
        return new Promise<'ran'>(() => undefined); // never finishes
      },
    };
    const started = Date.now();
    await runHostedWorker({
      db,
      channel: null,
      signal: controller.signal,
      dataDir: dir,
      backupJob: job,
      log,
      intervalMs: 5,
      backupWaitMs: 80,
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a failing backup check never stops the worker', async () => {
    const db = memoryDb();
    const controller = new AbortController();
    let ticks = 0;
    const job = {
      tick: async (): Promise<'ran'> => {
        ticks += 1;
        if (ticks === 3) controller.abort();
        throw new Error('boom');
      },
    };
    await runHostedWorker({
      db,
      channel: null,
      signal: controller.signal,
      dataDir: dir,
      backupJob: job,
      log,
      intervalMs: 5,
    });
    expect(ticks).toBe(3);
  });

  it('works without backups configured', async () => {
    const db = memoryDb();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await runHostedWorker({
      db,
      channel: null,
      signal: controller.signal,
      dataDir: dir,
      backupJob: null,
      log,
      intervalMs: 5,
    });
    expect(fs.existsSync(heartbeatPath(dir))).toBe(true);
  });
});

describe('shutdown waits for a backup that outlasts a cycle', () => {
  it('a later cycle that finds the backup running does not replace it with an instantly finished one', async () => {
    const db = memoryDb();
    const controller = new AbortController();
    let finished = false;
    let started = 0;
    let cycles = 0;
    const job = {
      tick: () => {
        started += 1;
        return new Promise<'ran'>((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve('ran');
          }, 120),
        );
      },
    };
    const run = runHostedWorker({
      db,
      channel: null,
      signal: controller.signal,
      dataDir: dir,
      backupJob: job,
      log,
      intervalMs: 10,
      backupWaitMs: 3000,
    });
    // several cycles pass while the one slow backup is still running, then we are told to stop
    await new Promise((r) => setTimeout(r, 60));
    cycles = 1;
    controller.abort();
    await run;
    expect(cycles).toBe(1);
    expect(started).toBe(1); // never a second backup while one runs
    expect(finished).toBe(true); // and the stop waited for it before closing the database
  });
});
