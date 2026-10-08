/**
 * Log redaction. Everything the app writes to its log passes through here first, so that no
 * secret, token, cookie, URL with credentials or request body can appear, even by mistake.
 * Pure. Two layers: sensitive KEY names hide their whole value, and sensitive-looking TEXT is
 * replaced inside any string.
 */

export const REDACTED = '[redacted]';
const MAX_TEXT = 300;
const MAX_DEPTH = 5;
const MAX_KEYS = 40;

const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|authori[sz]ation|cookie|credential|api[-_]?key|private|signature|session|bearer|totp|otp|backup[-_]?key|access[-_]?key|body|payload|headers?|stepup/i;

// a URL: only the scheme and host survive (path, query and user info can hold tokens or signatures)
const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/(?:[^\s"'<>/@]*@)?([^\s"'<>/?#]+)[^\s"'<>]*/gi;
const BOT_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{25,}\b/g;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const KEY_VALUE =
  /\b([A-Za-z0-9_.-]*(?:pass(?:word)?|secret|token|api[-_]?key|authorization|cookie|signature)[A-Za-z0-9_.-]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const OPAQUE = /[A-Za-z0-9_\-+/=]{32,}/g;

const escapeForRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Exact secret values (and their common encodings) can never survive, whatever they look like. */
function secretForms(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 6) continue;
    out.add(s);
    out.add(encodeURIComponent(s));
    out.add(Buffer.from(s, 'utf8').toString('base64'));
    out.add(Buffer.from(s, 'utf8').toString('base64url'));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactText(input: string, secrets: readonly string[] = []): string {
  let s = input;
  for (const form of secretForms(secrets)) {
    s = s.replace(new RegExp(escapeForRegExp(form), 'g'), REDACTED);
  }
  s = s
    .replace(URL_RE, (_m, scheme: string, host: string) => `${scheme}://${host}/…`)
    .replace(BOT_TOKEN, REDACTED)
    .replace(BEARER, (_m, kind: string) => `${kind} ${REDACTED}`)
    .replace(AWS_KEY, REDACTED)
    .replace(JWT, REDACTED)
    .replace(KEY_VALUE, (_m, k: string) => `${k}=${REDACTED}`)
    .replace(OPAQUE, REDACTED);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…[cut]` : s;
}

/** Turns anything into something safe to log: plain data, redacted, bounded. Errors lose their stack. */
export function redactValue(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactText(value, secrets);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) {
    return { error: value.name, message: redactText(value.message, secrets) };
  }
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((v) => redactValue(v, secrets, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      const safeKey = redactText(k, secrets); // a secret used as a key must not survive either
      out[safeKey] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, secrets, depth + 1);
    }
    return out;
  }
  return '[unsupported]';
}
