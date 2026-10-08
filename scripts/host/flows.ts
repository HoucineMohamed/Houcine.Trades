import type { BackupName } from '@/domain/hosting/retention';
import {
  applyStagedRestore,
  listBackups,
  stageRestore,
  type RestoreDeps,
  type StageResult,
} from '@/hosting/restore';
import { StoreError } from '@/hosting/object-store';
import type { Io } from '../auth/flows';

/** The restore conversation. Logic only; the terminal is passed in so it can be tested. */

export const CONFIRM_RESTORE = 'RESTORE';
export const CONFIRM_STOPPED = 'STOPPED';

const STAGE_WORDS: Record<Exclude<StageResult, { ok: true }>['code'], string> = {
  not_found: 'That backup was not found.',
  download_failed: 'The backup could not be downloaded.',
  wrong_key_or_damaged:
    'The backup could not be decrypted: BACKUP_KEY is not the key it was made with, or the file is damaged.',
  not_a_database: 'The file is not a valid database backup.',
  integrity_failed: 'The backup failed its integrity check.',
  newer_than_app: 'The backup comes from a NEWER version of the app than the one running now.',
  write_failed: 'The backup could not be written to the disk.',
};

export function describeBackup(b: BackupName): string {
  const when = b.at
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC')
    .replace(/Z$/, ' UTC');
  return `${when}   ${b.kind}   (${b.migrations} database updates)`;
}

export interface RestoreFlowOptions {
  deps: RestoreDeps;
  databaseFile: string;
  /** Apply right away (only when the app is stopped). Otherwise the swap happens at the next start. */
  swapNow: boolean;
  /** A backup chosen on the command line, or null to pick from the list. */
  objectKey: string | null;
}

export async function restoreFlow(io: Io, o: RestoreFlowOptions): Promise<number> {
  let backups: BackupName[];
  try {
    backups = await listBackups(o.deps.store, o.deps.prefix);
  } catch (e) {
    io.print(
      `Could not list the backups (${e instanceof StoreError ? e.code : 'unexpected'}). Nothing was changed.`,
    );
    return 1;
  }
  if (backups.length === 0) {
    io.print('There are no backups in the storage.');
    return 1;
  }

  let chosen: BackupName | undefined;
  if (o.objectKey) {
    chosen = backups.find((b) => b.key === o.objectKey);
    if (!chosen) {
      io.print('That backup is not in the list. Run again without a name to see the list.');
      return 1;
    }
  } else {
    const shown = backups.slice(0, 30);
    io.print('Backups, newest first:');
    shown.forEach((b, i) => io.print(`  ${String(i + 1).padStart(2)}.  ${describeBackup(b)}`));
    const answer = (
      await io.readLine('Number of the backup to restore (empty to cancel): ')
    ).trim();
    if (answer === '') {
      io.print('Cancelled. Nothing was changed.');
      return 1;
    }
    const n = /^\d{1,3}$/.test(answer) ? Number(answer) : 0;
    chosen = shown[n - 1];
    if (!chosen) {
      io.print('That is not a number in the list. Nothing was changed.');
      return 1;
    }
  }

  io.print();
  io.print(`You chose: ${describeBackup(chosen)}`);
  io.print('The current database will be replaced by this backup. The current database is');
  io.print('NOT deleted: it is kept next to it with ".before-restore" in its name.');
  const typed = (
    await io.readLine(`Type ${CONFIRM_RESTORE} (capital letters) to continue: `)
  ).trim();
  if (typed !== CONFIRM_RESTORE) {
    io.print('Cancelled. Nothing was changed.');
    return 1;
  }

  io.print('Downloading, decrypting and checking the backup...');
  const staged = await stageRestore(o.deps, chosen.key);
  if (!staged.ok) {
    io.print(`${STAGE_WORDS[staged.code]} Nothing was changed.`);
    return 1;
  }
  const m = staged.migrations;
  io.print(
    `The backup is intact (${m.applied} database updates${m.pending > 0 ? `, ${m.pending} more will be applied at the next start, after a new backup` : ''}).`,
  );

  if (!o.swapNow) {
    io.print();
    io.print('It is staged. Now RESTART the service (Render dashboard > Manual Deploy > Restart,');
    io.print(
      'or stop and start it). The swap happens at the start, before anything opens the database.',
    );
    return 0;
  }

  io.print();
  io.print('Swapping now is safe ONLY if the app and the worker are stopped.');
  const stopped = (await io.readLine(`Type ${CONFIRM_STOPPED} if they are stopped: `)).trim();
  if (stopped !== CONFIRM_STOPPED) {
    io.print('Not swapped. The backup stays staged and will be applied at the next start.');
    return 1;
  }
  const applied = await applyStagedRestore({
    dataDir: o.deps.dataDir,
    databaseFile: o.databaseFile,
    migrationsFolder: o.deps.migrationsFolder,
    clock: o.deps.clock,
    log: o.deps.log,
  });
  if (!applied.applied) {
    io.print(`The swap did not happen (${applied.reason}). The current database is unchanged.`);
    return 1;
  }
  io.print('Done. The restored database is in place.');
  if (applied.keptAs)
    io.print('The previous database was kept as a file with ".before-restore" in its name.');
  return 0;
}
