import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DRIZZLE = path.resolve(import.meta.dirname, '..', '..', 'drizzle');

/** A copy of the migrations folder that stops at `lastTag` (an older app version). */
export function folderUpTo(lastTag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-migrations-'));
  fs.cpSync(DRIZZLE, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.slice(
    0,
    journal.entries.findIndex((e) => e.tag === lastTag) + 1,
  );
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/** The real migrations plus one more that fails half way (a syntax error after a valid statement). */
export function folderWithBrokenMigration(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-migrations-'));
  fs.cpSync(DRIZZLE, dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '0007_broken.sql'),
    'CREATE TABLE `half_done` (`id` integer);--> statement-breakpoint\nCREATE TABLE `broken` (`id` integer,;',
  );
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  const last = journal.entries.at(-1);
  journal.entries.push({
    idx: (last?.idx ?? 0) + 1,
    version: '6',
    when: (last?.when ?? 0) + 1000,
    tag: '0007_broken',
    breakpoints: true,
  });
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

export const removeDir = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });
