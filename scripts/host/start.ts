import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { runBoot } from '@/hosting/boot';
import { readHostingConfig } from '@/hosting/config';
import { createLogger, secretsFromEnv } from '@/hosting/logger';
import { createS3Store } from '@/hosting/object-store';
import { startSetupServer } from '@/hosting/setup-server';
import { realStartupIo } from '@/hosting/startup';
import type { ChildSpec } from '@/hosting/supervisor';
import { deliverPending } from '@/notifications/delivery';
import { getChannelRuntime } from '@/notifications/runtime';

/**
 * The container's entry point (`npm run host:start`). See src/hosting/boot.ts for the sequence.
 * Stdout is the platform's log: JSON lines, every one passed through the redactor.
 */
const require = createRequire(import.meta.url);

async function main(): Promise<number> {
  const env = process.env;
  const secrets = secretsFromEnv(env);
  const log = createLogger({ service: 'supervisor', secrets });
  const cfg = readHostingConfig(env);
  const nextBin = require.resolve('next/dist/bin/next');
  const tsxCli = require.resolve('tsx/cli');

  return runBoot({
    env,
    io: realStartupIo(),
    log,
    store: cfg.store ? createS3Store(cfg.store) : null,
    key: cfg.backupKey,
    clock: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    startSetupServer,
    specs: (port): ChildSpec[] => [
      {
        name: 'web',
        command: process.execPath,
        args: [nextBin, 'start', '-H', '0.0.0.0', '-p', String(port)],
        env: { ...env, NODE_ENV: 'production' },
      },
      {
        name: 'worker',
        command: process.execPath,
        args: [tsxCli, '--conditions=react-server', 'scripts/host/worker.ts'],
        env: { ...env, NODE_ENV: 'production' },
      },
    ],
    supervisor: {
      spawn: (spec) =>
        spawn(spec.command, [...spec.args], {
          env: spec.env as NodeJS.ProcessEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
      write: (line) => process.stdout.write(`${line}\n`),
      secrets,
      graceMs: 20_000,
    },
    deliver: async (db) => {
      // best effort, bounded: the worker is not running yet when a release step fails
      const runtime = getChannelRuntime();
      await Promise.race([
        deliverPending(db, runtime.channel),
        new Promise((resolve) => setTimeout(resolve, 20_000)),
      ]);
    },
    onStopSignal: (stop) => {
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    },
  });
}

void main()
  .then((code) => process.exit(code))
  .catch(() => {
    console.error(JSON.stringify({ level: 'error', service: 'supervisor', event: 'boot.crashed' }));
    process.exit(1);
  });
