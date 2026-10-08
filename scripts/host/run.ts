import { readHostingConfig, type HostingConfig } from '@/hosting/config';
import { createLogger, secretsFromEnv, type Logger } from '@/hosting/logger';
import { createS3Store, type ObjectStore } from '@/hosting/object-store';

/** Shared start-up for the hosting command-line scripts. Prints names of problems, never values. */

export interface HostingContext {
  cfg: HostingConfig;
  store: ObjectStore;
  key: Buffer;
  log: Logger;
}

export function hostingContext(service: string): HostingContext | null {
  const cfg = readHostingConfig(process.env);
  const log = createLogger({ service, secrets: secretsFromEnv(process.env) });
  if (!cfg.store || !cfg.backupKey) {
    console.error(
      'The backup settings are incomplete. Needed: BACKUP_KEY, S3_ENDPOINT, S3_REGION, S3_BUCKET,',
    );
    console.error(
      'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (see docs/deploy.md). Nothing was done.',
    );
    return null;
  }
  return { cfg, store: createS3Store(cfg.store), key: cfg.backupKey, log };
}
