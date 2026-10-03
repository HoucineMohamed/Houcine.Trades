import { createDatabase, migrateDatabase, type Db } from '@/data/client';

/** Fresh in-memory database with the committed migrations applied. Never touches the disk. */
export function memoryDb(): Db {
  const db = createDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

export function fixedClock(...isoTimes: string[]) {
  let i = 0;
  return () => new Date(isoTimes[Math.min(i++, isoTimes.length - 1)] as string);
}
