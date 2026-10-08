import { isHosted } from '@/auth/hosted';
import { listBackupRuns, readBackupStatus } from '@/data/backups';
import {
  BACKUP_ERROR_WORDS,
  BACKUP_STATE_WORDS,
  backupIsProblem,
  backupState,
} from '@/domain/hosting/backup-health';
import { RETENTION } from '@/domain/hosting/retention';
import { formatLocal } from '../_lib/form';
import { guardedPage } from '../_lib/guard';

/**
 * Backup status. Display only: the backups themselves are made by the worker (daily, and before every
 * migration) and restored with the command-line script. Nothing on this page changes anything.
 */
export default guardedPage(async (ctx) => {
  const hosted = isHosted();
  const status = readBackupStatus(ctx.db);
  const runs = listBackupRuns(ctx.db, 30);
  const state = backupState({ ...status, now: ctx.now });
  return (
    <main>
      <div className="page-head">
        <h1>Backups</h1>
        <div className="lead">
          Encrypted copies of the database, kept off the hosting platform. This page only shows
          their status.
        </div>
      </div>

      <section aria-labelledby="backup-status-title">
        <h2 id="backup-status-title">Status</h2>
        {!hosted ? (
          <p>
            Backups run on the hosted app only. On your own computer none are made here. See
            docs/deploy.md to set them up.
          </p>
        ) : (
          <>
            <p role={backupIsProblem(state) ? 'alert' : 'status'}>
              <strong>{BACKUP_STATE_WORDS[state]}</strong>
            </p>
            <ul>
              <li>
                Last verified backup:{' '}
                {status.lastSuccessAt
                  ? `${formatLocal(status.lastSuccessAt)} (local time)`
                  : 'none'}
              </li>
              <li>
                Last failed attempt:{' '}
                {status.lastFailureAt
                  ? `${formatLocal(status.lastFailureAt)} (local time)`
                  : 'none'}
              </li>
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="backup-how-title">
        <h2 id="backup-how-title">How it works</h2>
        <ul>
          <li>A backup is made once a day, and once before every database update.</li>
          <li>
            Each backup is a consistent snapshot, encrypted on the server before it leaves, then
            downloaded again and checked. Only a checked backup counts.
          </li>
          <li>
            Kept: the newest of each of the last {RETENTION.daily} days, {RETENTION.weekly} weeks
            and {RETENTION.monthly} months, and the {RETENTION.preMigration} newest made before a
            database update. The newest backup is never deleted.
          </li>
          <li>
            The key that encrypts them (BACKUP_KEY) is not stored with them. Keep a copy in your
            password manager: without it no backup can be read.
          </li>
          <li>
            The disk snapshots the platform makes are an extra copy, never a replacement for these.
          </li>
        </ul>
      </section>

      <section aria-labelledby="backup-runs-title">
        <h2 id="backup-runs-title">Recent attempts</h2>
        {runs.length === 0 ? (
          <p>No backup has been attempted yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When (local)</th>
                  <th>Kind</th>
                  <th>Result</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{formatLocal(r.finishedAt)}</td>
                    <td>{r.kind}</td>
                    <td>
                      {r.outcome === 'ok'
                        ? 'verified'
                        : `failed: ${r.errorCode ? BACKUP_ERROR_WORDS[r.errorCode] : 'unknown'}`}
                    </td>
                    <td>
                      {r.sizeBytes === null ? '' : `${r.sizeBytes.toLocaleString('en-US')} bytes`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
});
