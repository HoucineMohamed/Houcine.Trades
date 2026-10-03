import type { z } from 'zod';

export interface ValidationIssue {
  /** Field name, or "" for a problem with the whole input. */
  field: string;
  message: string;
}

/** Thrown for any invalid input. `issues` is a list of clear, human-readable problems. */
export class ValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((i) => (i.field ? `${i.field}: ${i.message}` : i.message)).join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** Parses `input` with a zod schema; throws ValidationError (never a raw zod error). */
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message:
          issue.code === 'unrecognized_keys'
            ? `these fields cannot be set here: ${issue.keys.join(', ')}`
            : issue.message,
      })),
    );
  }
  return result.data;
}
