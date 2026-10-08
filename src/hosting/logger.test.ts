import { describe, expect, it } from 'vitest';
import { createLogger, secretsFromEnv } from './logger';

const rnd = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 5 + n) % 36],
  ).join('');
const AUTH = `auth${rnd(40)}`;
const KEY = rnd(43);
const S3 = rnd(30);
const TG = `1234567890:${rnd(35)}`;
const lines: string[] = [];
const log = createLogger({
  write: (l) => lines.push(l),
  clock: () => new Date('2026-10-08T03:00:00Z'),
  secrets: secretsFromEnv({
    AUTH_SECRET: AUTH,
    BACKUP_KEY: KEY,
    S3_SECRET_ACCESS_KEY: S3,
    TELEGRAM_BOT_TOKEN: TG,
  }),
  service: 'web',
});
const last = () => JSON.parse(lines.at(-1) as string) as Record<string, unknown>;

describe('logger', () => {
  it('writes one JSON object per line with fixed fields', () => {
    log.info('backup.ok', { bytes: 12 });
    expect(last()).toEqual({
      ts: '2026-10-08T03:00:00.000Z',
      level: 'info',
      service: 'web',
      event: 'backup.ok',
      bytes: 12,
    });
  });

  it('no secret, token, cookie, credentialed URL or request body can get out', () => {
    log.error('request.failed', {
      message: `failed https://u:p@api.telegram.org/bot${TG}/sendMessage?x=${S3}`,
      cookie: '__Host-houcine_session=abc',
      body: { password: 'hunter2', notes: 'private' },
      headers: { authorization: 'Bearer abc.def.ghi' },
      auth: AUTH,
      nested: { deep: [`key is ${KEY}`, `s3 ${S3}`] },
      err: new Error(`boom ${AUTH}`),
    });
    const line = lines.at(-1) as string;
    for (const secret of [
      AUTH,
      KEY,
      S3,
      TG,
      'hunter2',
      'private',
      '__Host-houcine_session',
      'u:p@',
      'abc.def.ghi',
    ]) {
      expect(line, secret).not.toContain(secret);
    }
    expect(line).toContain('request.failed');
  });

  it('an event name is a fixed word: anything else is replaced', () => {
    log.info(`user ${AUTH} did a thing`);
    expect(last().event).toBe('invalid_event');
    expect(lines.at(-1)).not.toContain(AUTH);
  });

  it('a field cannot overwrite ts, level, service or event', () => {
    log.warn('x.y', { level: 'fake', ts: 'fake', event: 'fake', service: 'fake' });
    expect(last()).toMatchObject({
      level: 'warn',
      service: 'web',
      event: 'x.y',
      ts: '2026-10-08T03:00:00.000Z',
    });
  });

  it('a failing writer never breaks the caller', () => {
    const broken = createLogger({
      write: () => {
        throw new Error('closed');
      },
    });
    expect(() => broken.error('x.y', {})).not.toThrow();
  });

  it('secretsFromEnv picks the right variables and ignores empty or tiny values', () => {
    expect(
      secretsFromEnv({
        AUTH_SECRET: 'abcdefgh',
        BACKUP_KEY: '',
        S3_SECRET_ACCESS_KEY: 'abc',
        HOME: '/root',
      }),
    ).toEqual(['abcdefgh']);
  });
});
