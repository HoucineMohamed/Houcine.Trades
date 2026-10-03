import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getEnv } from '@/config/env';

/**
 * Opens the SQLite database. No tables exist yet: schema arrives with the
 * "data model and journal" module. Call this lazily (never at import time)
 * so builds and tests do not create database files.
 */
export function openDatabase() {
  const url = getEnv().DATABASE_URL;
  const file = url.replace(/^file:/, '');
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite);
}
