export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} was not found`);
    this.name = 'NotFoundError';
  }
}

/** True for a SQLite UNIQUE violation, however the driver wrapped the error. */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
