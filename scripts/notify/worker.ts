import { getNotificationSettings } from '@/data/notifications';
import { getChannelRuntime } from '@/notifications/runtime';
import { runWorker } from '@/notifications/worker';
import { loadEnvFile, openDatabase } from '../auth/run';

/**
 * `npm run notify:worker`: collects new events and delivers pending ones, every 30 seconds, until you
 * press Ctrl+C. It prints counts only, never a message, a token or an error text. Module 8 will run it
 * as a service. It never touches a trade, a halt or a login.
 */
async function main(): Promise<number> {
  loadEnvFile();
  const db = openDatabase();
  const runtime = getChannelRuntime();
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  console.log('Alerts worker started. Press Ctrl+C to stop.');
  console.log(
    `Telegram: ${runtime.configured ? 'set up' : 'NOT set up (run npm run notify:set-telegram)'}.`,
  );
  console.log(
    `Alerts switch: ${getNotificationSettings(db).master ? 'ON' : 'OFF (nothing is sent until you switch it on)'}.`,
  );

  await runWorker({
    db,
    channel: runtime.channel,
    signal: controller.signal,
    onCycle: (r) => {
      const parts = [
        r.collect ? `${r.collect.recorded} new` : 'collecting off',
        r.deliver
          ? `${r.deliver.sent} sent, ${r.deliver.failed} failed, ${r.deliver.held} held`
          : 'no delivery',
        ...r.errors,
      ];
      if (r.collect?.recorded || r.deliver?.sent || r.deliver?.failed || r.errors.length > 0) {
        console.log(`${new Date().toISOString()}  ${parts.join(' | ')}`);
      }
    },
  });
  console.log('Alerts worker stopped.');
  return 0;
}

void main()
  .then((code) => process.exit(code))
  .catch(() => {
    console.error(
      'The alerts worker could not start (is the database set up? run npm run db:migrate).',
    );
    process.exit(1);
  });
