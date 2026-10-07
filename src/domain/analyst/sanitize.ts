import { TRUNCATION_MARKER } from './limits';

/**
 * Text written by the user (notes, emotions, setup names, questions) is UNTRUSTED: it could
 * contain words that look like instructions. It is cleaned, cut to a fixed length and wrapped in
 * a delimited data block; the system prompt tells the model to treat the block as data only.
 */

// Control characters except newline and tab.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const KEY_LIKE = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const LONG_SECRET = /\b[A-Za-z0-9+/_=-]{32,}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const LONG_DIGITS = /\b\d(?:[ -]?\d){8,}\b/g;

/** Masks things that look like emails, keys, long secrets, IBANs or account numbers. */
export function scrubSensitive(text: string): string {
  return text
    .replace(EMAIL, '[email removed]')
    .replace(KEY_LIKE, '[key removed]')
    .replace(IBAN, '[account number removed]')
    .replace(LONG_DIGITS, '[number removed]')
    .replace(LONG_SECRET, '[secret removed]');
}

/** `<` and `>` are replaced so the text can never close or open a data block. */
export function neutralize(text: string): string {
  return text.replace(CONTROL, ' ').replace(/</g, '‹').replace(/>/g, '›');
}

export interface Cut {
  text: string;
  truncated: boolean;
}

/** Cuts to `max` characters (by code point) and appends the visible marker when it cut. */
export function cut(text: string, max: number): Cut {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false };
  return { text: chars.slice(0, max).join('') + ' ' + TRUNCATION_MARKER, truncated: true };
}

/** A symbol is structural, so only symbol-like characters survive. */
export function safeSymbol(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9._\-/:]/g, '').slice(0, 30) || 'UNKNOWN';
}

export interface Block {
  text: string;
  truncated: boolean;
}

/** A delimited data block holding user text. The label is fixed by the code, never by the user. */
export function untrustedBlock(label: string, text: string, maxChars: number): Block {
  const cleaned = neutralize(scrubSensitive(text.trim()));
  const c = cut(cleaned, maxChars);
  return {
    text: `<untrusted_data label="${label}">\n${c.text === '' ? '(empty)' : c.text}\n</untrusted_data>`,
    truncated: c.truncated,
  };
}
