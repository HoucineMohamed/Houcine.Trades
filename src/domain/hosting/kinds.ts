/** Kept with no imports so the database schema (loaded by drizzle-kit) can use it. */
export const BACKUP_KINDS = ['daily', 'pre-migration', 'manual'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_OUTCOMES = ['ok', 'failed'] as const;
export type BackupOutcome = (typeof BACKUP_OUTCOMES)[number];

/** Short codes only: a failure is never stored as free text (it could hold a URL or a key). */
export const BACKUP_ERROR_CODES = [
  'snapshot_failed',
  'snapshot_corrupt',
  'encrypt_failed',
  'upload_failed',
  'verify_failed',
  'store_unreachable',
  'store_denied',
  'not_configured',
  'unexpected',
] as const;
export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number];
