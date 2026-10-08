import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, heartbeatPath, touchHeartbeat, WORKER_STALE_MS } from '@/hosting/health';
import { memoryDb } from '../helpers/db';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-health-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('checkHealth', () => {
  it('local: ok when the database answers', () => {
    expect(checkHealth({ env: {}, db: () => memoryDb() })).toBe(true);
  });
  it('not ok when the database cannot be opened or read (and never throws)', () => {
    expect(
      checkHealth({
        env: {},
        db: () => {
          throw new Error('SQLITE_CANTOPEN /secret/path');
        },
      }),
    ).toBe(false);
    const db = memoryDb();
    db.$client.close();
    expect(checkHealth({ env: {}, db: () => db })).toBe(false);
  });
  it('hosted: needs a recent sign of life from the worker', () => {
    const env = { HOSTED: 'true', DATA_DIR: dir };
    const now = new Date();
    expect(checkHealth({ env, now, db: () => memoryDb() })).toBe(false); // never written
    expect(touchHeartbeat(dir, now)).toBe(true);
    expect(checkHealth({ env, now, db: () => memoryDb() })).toBe(true);
    const later = new Date(now.getTime() + WORKER_STALE_MS + 5_000);
    expect(checkHealth({ env, now: later, db: () => memoryDb() })).toBe(false); // the worker hung
  });
  it('hosted without a DATA_DIR is not ok', () => {
    expect(checkHealth({ env: { HOSTED: 'true' }, db: () => memoryDb() })).toBe(false);
  });
  it('touchHeartbeat never throws', () => {
    expect(touchHeartbeat(path.join(dir, 'does', 'not', 'exist'))).toBe(false);
    expect(heartbeatPath(dir)).toBe(path.join(dir, '.worker-heartbeat'));
  });
});

describe('GET /healthz', () => {
  it('answers exactly "ok" or "not ok", with no details, no version, no data', async () => {
    vi.resetModules();
    vi.doMock('@/hosting/health', () => ({ checkHealth: () => true }));
    const { GET } = await import('@/app/healthz/route');
    const ok = await GET(new Request('http://127.0.0.1:3000/healthz'));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ok');
    expect([...ok.headers.keys()].sort()).toEqual(['cache-control', 'content-type']);
    expect(ok.headers.get('cache-control')).toBe('no-store');

    vi.resetModules();
    vi.doMock('@/hosting/health', () => ({ checkHealth: () => false }));
    const mod = await import('@/app/healthz/route');
    const bad = await mod.GET(new Request('http://127.0.0.1:3000/healthz'));
    expect(bad.status).toBe(503);
    expect(await bad.text()).toBe('not ok');
    vi.doUnmock('@/hosting/health');
  });

  it('a crash inside the check is "not ok", with nothing about the crash', async () => {
    vi.resetModules();
    vi.doMock('@/hosting/health', () => ({
      checkHealth: () => {
        throw new Error('db at /var/data/app.db: password=hunter2');
      },
    }));
    const { GET } = await import('@/app/healthz/route');
    const res = await GET(new Request('http://127.0.0.1:3000/healthz'));
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe('not ok');
    vi.doUnmock('@/hosting/health');
  });

  it('only GET is exported (Next answers 405 for the rest)', async () => {
    vi.resetModules();
    const mod = await import('@/app/healthz/route');
    expect(Object.keys(mod).sort()).toEqual(['GET', 'dynamic']);
  });
});
