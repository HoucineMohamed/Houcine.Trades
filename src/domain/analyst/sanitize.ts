import { TRUNCATION_MARKER } from './limits';

/**
 * Text written by the user (notes, emotions, setup names, questions) is UNTRUSTED: it could
 * contain words that look like instructions. It is cleaned, cut to a fixed length and wrapped in
 * a delimited data block; the system prompt tells the model to treat the block as data only.
 */

// Control characters except newline and tab.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// Anything a reader or a model may treat as a LINE BREAK besides \n: CR, NEL, line/paragraph separators.
const LINE_BREAKS = /\r\n?|[\u0085\u2028\u2029]/g;
// Invisible characters that can hide text or split a secret: zero-width, bidi controls, BOM.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const KEY_LIKE = /\bsk-[A-Za-z0-9_-]{16,}\b/gi;
const LONG_SECRET = /\b[A-Za-z0-9+/_=-]{32,}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
// 9+ digits in a row, or card-style groups (4-3/4-3/4 ...), that are NOT part of a decimal number
const LONG_DIGITS = /(?<![\d.])(?:\d{9,}|\d{4}(?:[ -]\d{3,4}){2,})(?!\d|\.\d)/g;

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
  return text
    .replace(LINE_BREAKS, '\n')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/</g, '‹')
    .replace(/>/g, '›');
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

/** A short structural value (a symbol, a currency, a direction): safe characters only, one line. */
export function safeToken(value: string | null | undefined, max = 40): string {
  const cleaned = (value ?? '')
    .replace(/[^A-Za-z0-9._:/ +-]/g, '')
    .trim()
    .slice(0, max);
  return cleaned === '' ? 'n/a' : cleaned;
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
  // invisible characters and odd line breaks go FIRST, so they cannot hide a secret from the scrub
  const cleaned = neutralize(scrubSensitive(neutralize(text).trim()));
  const c = cut(cleaned, maxChars);
  // Every line starts with "| ", so a forged heading or tag can never begin a line of its own.
  const body = (c.text === '' ? '(empty)' : c.text)
    .split('\n')
    .map((l) => `| ${l}`)
    .join('\n');
  return {
    text: `<untrusted_data label="${label}">\n${body}\n</untrusted_data>`,
    truncated: c.truncated,
  };
}

/** Engine or other trusted text, flattened to ONE bounded line (no line break can start a fake section). */
export function oneLine(text: string, max = 300): string {
  const flat = neutralize(text).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return cut(flat, max).text;
}
