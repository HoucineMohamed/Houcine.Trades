import { connection } from 'next/server';
import { getDb } from '@/data/client';

/**
 * The database for a page or action. `connection()` makes sure this only runs for a real
 * request, never while `next build` prerenders (so a build never creates a database file).
 */
export async function requireDb() {
  await connection();
  return getDb();
}
