import { describe, expect, it } from 'vitest';
import { WORKER_ONLY_SETTINGS, webEnvironment } from './child-env';

describe('the web server environment', () => {
  const env = {
    AUTH_SECRET: 'a',
    TRUST_PROXY: 'true',
    DATA_DIR: '/var/data',
    ANTHROPIC_API_KEY: 'k',
    TELEGRAM_BOT_TOKEN: 't',
    BACKUP_KEY: 'b',
    S3_ENDPOINT: 'e',
    S3_REGION: 'r',
    S3_BUCKET: 'bk',
    S3_ACCESS_KEY_ID: 'i',
    S3_SECRET_ACCESS_KEY: 's',
    S3_PREFIX: 'p',
  };
  it('has no backup key and no storage credentials', () => {
    const web = webEnvironment(env);
    for (const name of WORKER_ONLY_SETTINGS) expect(web, name).not.toHaveProperty(name);
    expect(Object.keys(web).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'AUTH_SECRET',
      'DATA_DIR',
      'TELEGRAM_BOT_TOKEN',
      'TRUST_PROXY',
    ]);
  });
  it('does not change the original, and every worker-only name is listed', () => {
    webEnvironment(env);
    expect(env.BACKUP_KEY).toBe('b');
    expect([...WORKER_ONLY_SETTINGS].sort()).toEqual([
      'BACKUP_KEY',
      'S3_ACCESS_KEY_ID',
      'S3_BUCKET',
      'S3_ENDPOINT',
      'S3_PREFIX',
      'S3_REGION',
      'S3_SECRET_ACCESS_KEY',
    ]);
  });
});
