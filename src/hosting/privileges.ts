import 'server-only';
import fs from 'node:fs';

/**
 * The command-line scripts (create the owner, back up, restore) are often started from an SSH shell
 * that is ROOT. A root process that creates the database's side files (-wal, -shm) or the restore
 * folder would leave files the app's unprivileged user cannot open. So, when running as root, the
 * script first steps down to the user that owns the data folder (the entrypoint makes that the app
 * user). Not root: nothing happens.
 */

export interface ProcessLike {
  getuid?: () => number;
  setuid?: (uid: number) => void;
  setgid?: (gid: number) => void;
  initgroups?: (user: number, group: number) => void;
}

export type DropResult = 'not_root' | 'dropped' | 'failed';

export function dropToDataOwner(
  dataDir: string,
  proc: ProcessLike = process,
  stat: (p: string) => { uid: number; gid: number } = fs.statSync,
): DropResult {
  if (proc.getuid?.() !== 0) return 'not_root';
  try {
    const { uid, gid } = stat(dataDir);
    if (uid === 0 || !proc.setuid || !proc.setgid) return 'failed'; // never "step down" to root
    proc.initgroups?.(uid, gid);
    proc.setgid(gid);
    proc.setuid(uid);
    return proc.getuid?.() === uid || proc.getuid === undefined ? 'dropped' : 'failed';
  } catch {
    return 'failed';
  }
}
