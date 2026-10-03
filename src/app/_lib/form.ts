import { NotFoundError } from '@/data/errors';
import { ValidationError } from '@/domain/errors';

export type FormValues = Record<string, string>;

export interface FormState {
  errors: string[];
  /** What the user typed, sent back so a failed submit does not wipe the form. */
  values: FormValues;
}

export const emptyFormState: FormState = { errors: [], values: {} };

export function formValues(formData: FormData): FormValues {
  const out: FormValues = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string' && !key.startsWith('$ACTION')) out[key] = value;
  }
  return out;
}

export const blank = (v: string | undefined): boolean => v === undefined || v.trim() === '';

/** "" -> undefined (field not provided). */
export const orUndefined = (v: string | undefined) => (blank(v) ? undefined : v);

/** "" -> null (clear the field). */
export const orNull = (v: string | undefined) => (blank(v) ? null : v);

/** Whole number from a form field; anything else becomes undefined so the domain says "required". */
export function toId(v: string | undefined): number | undefined {
  if (blank(v) || !/^\d+$/.test((v as string).trim())) return undefined;
  return Number((v as string).trim());
}

/**
 * <input type="datetime-local"> gives "2026-10-03T18:21" with no time zone. The app runs on
 * your own computer, so that time is read as YOUR local time and stored as UTC.
 * Invalid text is passed through so the domain can report it.
 */
export function localToUtc(v: string | undefined): string | undefined {
  if (blank(v)) return undefined;
  const text = (v as string).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

/** UTC ISO -> "YYYY-MM-DDTHH:mm" in local time, for <input type="datetime-local">. */
export function utcToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "YYYY-MM-DD HH:mm" in local time, for display. */
export function formatLocal(iso: string | null | undefined): string {
  return iso ? utcToLocalInput(iso).replace('T', ' ') : '';
}

/** Turns known errors into messages for the user. Unknown errors are re-thrown. */
export function errorMessages(error: unknown): string[] {
  if (error instanceof ValidationError) {
    return error.issues.map((i) => (i.field ? `${i.field}: ${i.message}` : i.message));
  }
  if (error instanceof NotFoundError) return [error.message];
  throw error;
}
