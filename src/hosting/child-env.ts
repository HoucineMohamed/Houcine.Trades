/**
 * The web server faces the internet; it never makes or reads a backup. So it does not get the backup key
 * or the storage credentials: a flaw in the web process then cannot hand over the means to read or delete
 * the off-platform backups. Only the worker (which makes the backups) and the release step get them.
 */
export const WORKER_ONLY_SETTINGS = [
  'BACKUP_KEY',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PREFIX',
] as const;

export function webEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of WORKER_ONLY_SETTINGS) delete out[name];
  return out;
}
