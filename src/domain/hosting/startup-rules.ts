/**
 * The start-up rules for the hosted app. Pure: the caller gathers plain facts (src/hosting/startup.ts),
 * this decides. Hosted means HOSTED=true. Anything unknown or ambiguous is a refusal (fail closed),
 * with a message that says WHAT is wrong, never a value. Nothing here applies on your own computer.
 */

export interface StartupFacts {
  hosted: boolean;
  nodeEnv: string | undefined;
  tradingMode: string | undefined;
  /** AUTH_SECRET passes the app's own validation (length, not a placeholder, random enough). */
  authSecretValid: boolean;
  /** The raw TRUST_PROXY text, so "not set" can be told apart from "false". */
  trustProxyRaw: string | undefined;
  /** DATA_DIR is set and absolute. */
  dataDirValid: boolean;
  dataDirMounted: boolean | null;
  dataDirReadOnly: boolean | null;
  databaseInsideDataDir: boolean;
  backupKeyValid: boolean;
  objectStoreValid: boolean;
  /** true / false, or null when it could not be read. */
  ownerExists: boolean | null;
  /** Migrations still to apply, or null when it could not be read. */
  migrationsPending: number | null;
}

export type StartupCode =
  | 'not_production'
  | 'trading_mode'
  | 'auth_secret'
  | 'trust_proxy_unset'
  | 'data_dir'
  | 'data_dir_not_mounted'
  | 'data_dir_read_only'
  | 'database_outside_data_dir'
  | 'backup_key'
  | 'object_store'
  | 'owner_unreadable'
  | 'migrations_unreadable'
  | 'migrations_pending';

export const STARTUP_MESSAGES: Record<StartupCode, string> = {
  not_production: 'NODE_ENV must be "production" when HOSTED=true.',
  trading_mode: 'TRADING_MODE must be "paper": real execution does not exist.',
  auth_secret:
    'AUTH_SECRET is missing, too short, random-looking text is required, or it is still the placeholder.',
  trust_proxy_unset:
    'TRUST_PROXY must be set explicitly to "true" or "false" (on Render it is "true").',
  data_dir: 'DATA_DIR must be set to the absolute path where the persistent disk is mounted.',
  data_dir_not_mounted:
    'DATA_DIR is not a mounted disk. Data kept there would be lost at the next deploy. Attach the persistent disk at that path.',
  data_dir_read_only: 'The persistent disk is mounted read-only.',
  database_outside_data_dir:
    'DATABASE_URL must point to a file inside DATA_DIR (the persistent disk).',
  backup_key: 'BACKUP_KEY is missing, malformed or still the placeholder.',
  object_store:
    'The backup storage settings are incomplete or invalid (S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).',
  owner_unreadable: 'Could not check whether the owner exists.',
  migrations_unreadable: 'Could not check which database migrations are applied.',
  migrations_pending:
    'Database migrations are pending. They are applied only by the release step, after a verified backup.',
};

export interface StartupResult {
  ok: boolean;
  failures: { code: StartupCode; message: string }[];
  /** No owner yet: the web app and worker stay off; only the shell and /healthz are up. */
  setupMode: boolean;
}

export function evaluateStartup(f: StartupFacts): StartupResult {
  if (!f.hosted) return { ok: true, failures: [], setupMode: false };
  const bad = new Set<StartupCode>();
  if (f.nodeEnv !== 'production') bad.add('not_production');
  if (f.tradingMode !== 'paper') bad.add('trading_mode');
  if (!f.authSecretValid) bad.add('auth_secret');
  const t = f.trustProxyRaw?.trim().toLowerCase();
  if (t !== 'true' && t !== 'false') bad.add('trust_proxy_unset');
  if (!f.dataDirValid) bad.add('data_dir');
  else {
    if (f.dataDirMounted !== true) bad.add('data_dir_not_mounted');
    if (f.dataDirReadOnly !== false) bad.add('data_dir_read_only');
    if (!f.databaseInsideDataDir) bad.add('database_outside_data_dir');
  }
  if (!f.backupKeyValid) bad.add('backup_key');
  if (!f.objectStoreValid) bad.add('object_store');
  if (f.ownerExists === null) bad.add('owner_unreadable');
  // anything but a whole number zero or more (null, NaN, negative) is unreadable, never "fine"
  if (
    f.migrationsPending === null ||
    !Number.isInteger(f.migrationsPending) ||
    f.migrationsPending < 0
  ) {
    bad.add('migrations_unreadable');
  } else if (f.migrationsPending > 0) bad.add('migrations_pending');
  const failures = [...bad].map((code) => ({ code, message: STARTUP_MESSAGES[code] }));
  return {
    ok: failures.length === 0,
    failures,
    setupMode: failures.length === 0 && f.ownerExists === false,
  };
}
