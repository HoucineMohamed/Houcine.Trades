import { readHostingConfig } from '@/hosting/config';
import { checkStartup, realStartupIo } from '@/hosting/startup';
import { loadEnvFile } from '../auth/run';

/**
 * `npm run host:check`: runs the same start-up rules the hosted app runs, and prints which ones
 * fail (names only, never values). Exit code 0 when everything is in order.
 */
loadEnvFile();
const cfg = readHostingConfig(process.env);
if (!cfg.hosted) {
  console.log(
    'HOSTED is not "true" here, so the hosted rules are not applied (this is normal on your own computer).',
  );
  process.exit(0);
}
const result = checkStartup(process.env, realStartupIo(), 'after_release');
if (result.ok) {
  console.log(
    result.setupMode
      ? 'OK. No owner yet: create one with npm run auth:create-owner.'
      : 'OK. Every start-up rule passes.',
  );
  process.exit(0);
}
for (const f of result.failures) console.log(`PROBLEM [${f.code}]: ${f.message}`);
process.exit(1);
