import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getDb, type Db } from '@/data/client';

/**
 * The answer behind /healthz. It returns ONLY true or false: no version, no counts, no names, no
 * reasons (the route turns it into the text "ok" or "not ok"). It is false when the database cannot
 * be read, and, when hosted, when the worker has not shown a sign of life recently, so the platform
 * restarts a container whose worker has hung.
 */

/** How long the worker's sign of life may be silent (the worker writes one every 30 seconds). */
export const WORKER_STALE_MS = 5 * 60_000;
export const HEARTBEAT_FILE_NAME = '.worker-heartbeat';

export const heartbeatPath = (dataDir: string) => path.join(dataDir, HEARTBEAT_FILE_NAME);

/** Called by the worker after every cycle. Never throws. */
export function touchHeartbeat(dataDir: string, now: Date = new Date()): boolean {
  try {
    const file = heartbeatPath(dataDir);
    fs.writeFileSync(file, now.toISOString(), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export interface HealthOptions {
  env?: Record<string, string | undefined>;
  now?: Date;
  db?: () => Db;
}

export function checkHealth(options: HealthOptions = {}): boolean {
  try {
    const env = options.env ?? process.env;
    const now = options.now ?? new Date();
    const db = (options.db ?? getDb)();
    db.get(sql`SELECT 1 FROM sqlite_master LIMIT 1`);
    if (env.HOSTED === 'true') {
      const dataDir = env.DATA_DIR;
      if (!dataDir) return false;
      const modified = fs.statSync(heartbeatPath(dataDir)).mtimeMs;
      const age = now.getTime() - modified;
      // fresh, and not dated in the future either (a future time would stay "fresh" for a long time)
      if (!(age <= WORKER_STALE_MS && age >= -60_000)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
