import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit does not read .env by itself; Node 22 can load it natively.
try {
  process.loadEnvFile();
} catch {
  // No .env file: fall back to the default below.
}

const url = process.env.DATABASE_URL ?? 'file:./data/houcine-trades.db';

// On a fresh clone the database folder does not exist yet; SQLite will not create it.
const file = url.replace(/^file:/, '');
if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/data/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
});
