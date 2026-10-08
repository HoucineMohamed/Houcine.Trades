import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { login } from '@/auth/service';
import { closeTradeAndSync, logTrade, openTradeChecked } from '@/data/journal';
import { haltManually, resetHalt, syncRiskState } from '@/data/risk';
import { setNotificationsMaster } from '@/data/notifications';
import { freshAuthForTests, CLIENT, codeAt, dbWithOwner, PASSWORD } from '../helpers/auth';
import { enableAlerts } from '../helpers/notifications';
import { riskDb } from '../helpers/risk';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const NOW = new Date('2026-03-10T12:00:00.000Z');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

describe('no trade, halt, risk, login or analyst code can call a notification (static proof)', () => {
  const NOTIFY =
    /from ['"](?:@\/notifications|@\/data\/notifications|@\/domain\/notifications|@\/integrations\/telegram)[^'"]*['"]|from ['"]\.\.?\/(?:[^'"]*\/)?notifications[^'"]*['"]/;
  const importers = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => NOTIFY.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).replaceAll('\\', '/'));

  it('only the notification modules, their page, the header indicator and their scripts import them', () => {
    const allowed = (f: string) =>
      f.startsWith('src/notifications/') ||
      f.startsWith('src/domain/notifications/') ||
      f.startsWith('src/integrations/telegram/') ||
      f.startsWith('src/app/notifications/') ||
      f.startsWith('scripts/notify/') ||
      f === 'src/data/notifications.ts' ||
      // module 8 (hosting): backup and release events enter the outbox as ordinary events, and the
      // hosted worker / start script run the notification worker. None of these is a trade, halt,
      // risk, login or analyst path.
      f === 'src/hosting/announce.ts' ||
      f === 'src/hosting/worker-main.ts' ||
      f === 'scripts/host/start.ts' ||
      f === 'scripts/host/worker.ts' ||
      f === 'src/data/schema.ts' || // the table definitions use the kind lists
      f === 'src/app/_lib/shell.tsx' || // the small header indicator (read only)
      f === 'src/app/_lib/help.ts';
    expect(importers.filter((f) => !allowed(f))).toEqual([]);
  });

  it('the risk, journal, trade, auth, analyst and proxy code is NOT among the importers', () => {
    const protectedPaths = [
      'src/data/journal.ts',
      'src/data/risk.ts',
      'src/data/risk-events.ts',
      'src/data/trades.ts',
      'src/data/auth.ts',
      'src/data/analyst.ts',
      'src/proxy.ts',
    ];
    for (const p of protectedPaths) expect(importers, p).not.toContain(p);
    for (const f of importers) {
      expect(f.startsWith('src/auth/'), f).toBe(false);
      expect(f.startsWith('src/domain/risk/'), f).toBe(false);
      expect(f.startsWith('src/analyst/'), f).toBe(false);
      expect(f.startsWith('src/app/trades/'), f).toBe(false);
      expect(f.startsWith('src/app/risk/'), f).toBe(false);
      expect(f.startsWith('src/app/login/'), f).toBe(false);
    }
  });

  it('no timer or scheduler in the web server code', () => {
    for (const f of walk(path.join(ROOT, 'src/notifications')).filter(
      (x) => /\.ts$/.test(x) && !/worker\.ts$/.test(x),
    )) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/setInterval/);
    }
    for (const f of walk(path.join(ROOT, 'src/app')).filter((x) => /\.(ts|tsx)$/.test(x))) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/setInterval|runWorker/);
    }
  });
});

describe('trade actions, halts and logins work unchanged with notifications ON but completely broken', () => {
  const PLAN = {
    accountId: 1,
    symbol: 'BTCUSDT',
    assetClass: 'crypto',
    direction: 'long',
    plannedEntry: '100',
    stopLoss: '95',
    takeProfit: '115',
    size: '20',
    quoteCurrency: 'USDT',
  };

  it('logging, opening and closing a trade, halting, resetting and syncing', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    // wreck every notification table, as if the feature were broken or the disk full
    db.$client.exec(
      'DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE notification_state; DROP TABLE notification_settings',
    );
    const logged = logTrade(db, PLAN, { now: () => NOW });
    expect(logged.trade.status).toBe('planned');
    openTradeChecked(
      db,
      logged.trade.id,
      { entryPrice: '100', openedAt: '2026-03-10T11:00:00Z' },
      { now: () => NOW },
    );
    closeTradeAndSync(
      db,
      logged.trade.id,
      { exitPrice: '99', closedAt: '2026-03-10T11:30:00Z' },
      { now: () => NOW },
    );
    haltManually(db, 1, 'testing', NOW);
    resetHalt(
      db,
      1,
      'manual',
      { confirm: 'RESET', reason: 'rested and reviewed' },
      freshAuthForTests(1, NOW),
      NOW,
    );
    expect(() => syncRiskState(db, 1, NOW)).not.toThrow();
  });

  it('a login', async () => {
    const owner = await dbWithOwner();
    owner.db.$client.exec(
      'INSERT INTO notification_settings (id, master, categories_json, updated_at) VALUES (1, 1, \'{"risk":true,"security":true,"analyst":true,"system":true}\', \'t\')',
    );
    owner.db.$client.exec(
      'PRAGMA foreign_keys = OFF; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE notification_settings',
    );
    const r = await login(
      owner.db,
      { password: PASSWORD, code: codeAt(owner.secret, new Date()) },
      CLIENT,
      { env: owner.env, now: new Date() },
    );
    expect(r.ok).toBe(true);
  });

  it('a trade the risk engine refuses is still refused, and a halt still blocks, with alerts on', () => {
    const db = riskDb();
    enableAlerts(db, NOW);
    haltManually(db, 1, 'testing', NOW);
    expect(() => logTrade(db, PLAN, { now: () => NOW })).toThrow();
    void setNotificationsMaster;
  });
});
