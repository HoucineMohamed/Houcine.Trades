import { Dec } from '@/domain/money/decimal';
import { displayMoney } from '@/domain/stats';

/**
 * Display formatting only. These helpers never calculate money or statistics: they take the exact
 * text the engines returned and add a thousands separator, a sign and a word. Rounding for display
 * uses the existing tested `displayMoney` (half-even, trailing zeros trimmed).
 */

/** Engine results may be negative (the domain's own isDecimalString is unsigned). */
const isDecimalString = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 120 && /^-?\d+(\.\d+)?$/.test(v);

const MINUS = '\u2212'; // a real minus sign, easier to see than a hyphen

/** "-1234567.891" -> "-1,234,567.891". Not a number -> returned unchanged (never throws). */
export function groupThousands(plain: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(plain);
  if (!m) return plain;
  const [, sign, whole, fraction] = m;
  return `${sign}${(whole as string).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ?? ''}`;
}

/** A money amount for display: at most `places` decimals, thousands separators, no sign added. */
export function formatAmount(value: string, places = 8): string {
  return isDecimalString(value) ? groupThousands(displayMoney(value, places)) : value;
}

/**
 * A money amount for people: two decimals for amounts of 1 or more ("11,403.30"), up to eight
 * trimmed decimals below 1 so a tiny non-zero amount never looks like zero. Display only.
 */
export function formatMoney(value: string): string {
  if (!isDecimalString(value)) return value;
  const abs = value.replace(/^-/, '');
  if (new Dec(abs).lt(1)) return formatAmount(value, 8);
  const [whole, fraction = ''] = groupThousands(displayMoney(value, 2)).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

export type ResultKind = 'profit' | 'loss' | 'flat';

/** Which way a result points: a classification for the sign and the label, not a calculation. */
export function resultKind(value: string): ResultKind {
  if (!isDecimalString(value)) return 'flat';
  const d = new Dec(value);
  return d.isZero() ? 'flat' : d.isNegative() ? 'loss' : 'profit';
}

export interface SignedText {
  /** "+1,234.5", "\u22121,234.5" or "0". */
  text: string;
  kind: ResultKind;
  /** A neutral word shown next to the number so colour is never the only signal. */
  word: 'profit' | 'loss' | 'break-even';
}

const WORD = { profit: 'profit', loss: 'loss', flat: 'break-even' } as const;

/** A result (net P&L, today's result): explicit sign, separators and a neutral word. */
export function formatSigned(value: string, places = 8): SignedText {
  if (!isDecimalString(value)) return { text: value, kind: 'flat', word: 'break-even' };
  const shown = displayMoney(value, places); // "-0" can never appear
  const kind = resultKind(shown);
  const grouped = groupThousands(shown.replace(/^-/, ''));
  const text = kind === 'profit' ? `+${grouped}` : kind === 'loss' ? `${MINUS}${grouped}` : '0';
  return { text, kind, word: WORD[kind] };
}

/** Like formatSigned, with the money precision of formatMoney. */
export function formatMoneySigned(value: string): SignedText {
  if (!isDecimalString(value)) return { text: value, kind: 'flat', word: 'break-even' };
  const kind = resultKind(displayMoney(value, 8));
  const body = formatMoney(value.replace(/^-/, ''));
  const text = kind === 'profit' ? `+${body}` : kind === 'loss' ? `${MINUS}${body}` : '0';
  return { text, kind, word: WORD[kind] };
}

/** R-multiples keep the engine's 4 decimals: "+1.5000 R". */
export function formatR(value: string): SignedText {
  if (!isDecimalString(value)) return { text: value, kind: 'flat', word: 'break-even' };
  const kind = resultKind(value);
  const abs = value.replace(/^-/, '');
  const body = `${abs} R`;
  const text = kind === 'profit' ? `+${body}` : kind === 'loss' ? `${MINUS}${body}` : body;
  return { text, kind, word: WORD[kind] };
}

/** "12.5" -> "12.5 %". */
export function formatPercent(value: string): string {
  return isDecimalString(value) ? `${value} %` : value;
}

/** An ISO time as "2026-03-10 12:00 UTC", for places where the server's time zone must not matter. */
export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** "3h 05m" style remaining time for a countdown given in milliseconds. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${p(m)}m` : m > 0 ? `${m}m ${p(s)}s` : `${s}s`;
}

/** Only http(s) links may be shown as links (never javascript:, data:, file:). */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}
