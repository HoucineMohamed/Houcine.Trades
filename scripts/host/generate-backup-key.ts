import { generateBackupKey } from '@/hosting/crypto';

/**
 * `npm run backup:generate-key`: prints a new random BACKUP_KEY (32 random bytes). Copy it into your
 * password manager AND into the platform's secret store. If it is lost, every backup made with it is
 * unreadable. It is never stored by this script.
 */
console.log(generateBackupKey());
console.error('');
console.error(
  'This is your BACKUP_KEY. Save it NOW in your password manager, and in the platform secret store.',
);
console.error('Lose it and every backup becomes unreadable. Never use your AUTH_SECRET here.');
