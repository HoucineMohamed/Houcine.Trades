import { asc, eq } from 'drizzle-orm';
import { ValidationError, parseWith } from '@/domain/errors';
import { setupSchema } from '@/domain/setups/setup';
import type { Db, Reader } from './client';
import { isUniqueViolation, NotFoundError } from './errors';
import { setups, type SetupRow } from './schema';

export type Setup = SetupRow;

const duplicateName = (name: string) =>
  new ValidationError([{ field: 'name', message: `A setup named "${name}" already exists` }]);

export function createSetup(db: Db, input: unknown, now: () => Date = () => new Date()): Setup {
  const data = parseWith(setupSchema, input);
  try {
    return db
      .insert(setups)
      .values({ ...data, createdAt: now().toISOString() })
      .returning()
      .get();
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateName(data.name);
    throw error;
  }
}

export function updateSetup(db: Db, id: number, input: unknown): Setup {
  const data = parseWith(setupSchema, input);
  try {
    const row = db.update(setups).set(data).where(eq(setups.id, id)).returning().get();
    if (!row) throw new NotFoundError(`Setup ${id}`);
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateName(data.name);
    throw error;
  }
}

export function getSetup(db: Reader, id: number): Setup | undefined {
  return db.select().from(setups).where(eq(setups.id, id)).get();
}

export function listSetups(db: Db): Setup[] {
  return db.select().from(setups).orderBy(asc(setups.name)).all();
}
