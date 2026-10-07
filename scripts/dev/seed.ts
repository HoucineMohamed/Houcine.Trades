import { assertDatabaseReady, createDatabase, migrateDatabase } from '@/data/client';
import { resolveDemoTarget, SeedRefusedError } from './guard';
import { assertFreshDatabase, seedDemo } from './seed-demo';

/**
 * npm run dev:seed - fills a DEMO database with made-up data. See the README ("Demo data").
 * It refuses unless DATABASE_URL names a demo file, and prints which file it uses first.
 */
function main(): number {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file: the shell environment may still set DATABASE_URL
  }
  try {
    const file = resolveDemoTarget(process.env.DATABASE_URL, process.cwd());
    console.log(`Demo database file: ${file}`);
    const db = createDatabase(file);
    assertFreshDatabase(db); // before migrating: a wrong file is not touched at all
    migrateDatabase(db);
    assertDatabaseReady(db);
    const s = seedDemo(db);
    console.log(
      `Done. Added the account "DEMO Paper Account" with ${s.closed} closed, 2 open, ${s.planned} planned and ${s.cancelled} cancelled demo trades.`,
    );
    console.log(
      'Next: create an owner for this demo file and start the app with the same DATABASE_URL (see the README).',
    );
    return 0;
  } catch (error) {
    console.error(`Refused: ${error instanceof Error ? error.message : 'unexpected problem'}`);
    return error instanceof SeedRefusedError ? 2 : 1;
  }
}

process.exit(main());
