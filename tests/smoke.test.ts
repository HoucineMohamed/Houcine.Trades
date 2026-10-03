import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/config/env';

describe('smoke: test setup and paper-mode guard', () => {
  it('defaults to paper mode with an empty environment', () => {
    expect(parseEnv({}).TRADING_MODE).toBe('paper');
  });

  it('refuses any trading mode other than paper', () => {
    expect(() => parseEnv({ TRADING_MODE: 'live' })).toThrow(/paper/);
    expect(() => parseEnv({ TRADING_MODE: '' })).toThrow();
  });
});
