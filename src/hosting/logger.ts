import 'server-only';
import { redactValue } from '@/domain/hosting/redact';

/**
 * Structured log: one JSON object per line on standard output (the platform collects it). Every
 * field passes through the redactor first, so a secret, token, cookie, credentialed URL or request
 * body cannot appear even by mistake. Event names are fixed words, never built from data.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const EVENT_NAME = /^[a-z0-9_.]{1,60}$/;

/** The values that must never appear in any log line, taken from the environment. */
export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  const names = [
    'AUTH_SECRET',
    'BACKUP_KEY',
    'S3_SECRET_ACCESS_KEY',
    'S3_ACCESS_KEY_ID',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'ANTHROPIC_API_KEY',
  ];
  return names
    .map((n) => env[n])
    .filter((v): v is string => typeof v === 'string' && v.length >= 6);
}

export function createLogger(options: {
  write?: (line: string) => void;
  clock?: () => Date;
  secrets?: readonly string[];
  service?: string;
}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const clock = options.clock ?? (() => new Date());
  const secrets = options.secrets ?? [];
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    const safeEvent = EVENT_NAME.test(event) ? event : 'invalid_event';
    const body = redactValue(fields ?? {}, secrets);
    const line: Record<string, unknown> = {
      ts: clock().toISOString(),
      level,
      service: options.service ?? 'app',
      event: safeEvent,
    };
    // user fields can never overwrite the four fixed ones
    if (body && typeof body === 'object') {
      for (const [k, v] of Object.entries(body)) if (!(k in line)) line[k] = v;
    }
    try {
      write(JSON.stringify(line));
    } catch {
      // logging must never break the thing being logged
    }
  };
  return {
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}
