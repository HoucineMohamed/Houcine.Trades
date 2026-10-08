import { describe, expect, it } from 'vitest';
import {
  evaluateStartup,
  STARTUP_MESSAGES,
  type StartupCode,
  type StartupFacts,
} from './startup-rules';

const GOOD: StartupFacts = {
  hosted: true,
  nodeEnv: 'production',
  tradingMode: 'paper',
  authSecretValid: true,
  trustProxyRaw: 'true',
  dataDirValid: true,
  dataDirMounted: true,
  dataDirReadOnly: false,
  databaseInsideDataDir: true,
  backupKeyValid: true,
  objectStoreValid: true,
  ownerExists: true,
  migrationsPending: 0,
};

describe('start-up rules', () => {
  it('a complete hosted setup starts', () => {
    expect(evaluateStartup(GOOD)).toEqual({ ok: true, failures: [], setupMode: false });
  });
  it('not hosted: nothing is checked (your own computer is unchanged)', () => {
    expect(
      evaluateStartup({ ...GOOD, hosted: false, authSecretValid: false, tradingMode: 'live' }).ok,
    ).toBe(true);
  });

  const cases: [string, Partial<StartupFacts>, StartupCode][] = [
    ['development mode', { nodeEnv: 'development' }, 'not_production'],
    ['no NODE_ENV', { nodeEnv: undefined }, 'not_production'],
    ['live trading', { tradingMode: 'live' }, 'trading_mode'],
    ['no trading mode seen', { tradingMode: undefined }, 'trading_mode'],
    ['bad auth secret', { authSecretValid: false }, 'auth_secret'],
    ['proxy trust not set', { trustProxyRaw: undefined }, 'trust_proxy_unset'],
    ['proxy trust junk', { trustProxyRaw: 'yes' }, 'trust_proxy_unset'],
    ['proxy trust empty', { trustProxyRaw: '' }, 'trust_proxy_unset'],
    ['no data dir', { dataDirValid: false }, 'data_dir'],
    ['data dir is not a mount', { dataDirMounted: false }, 'data_dir_not_mounted'],
    ['mount unknown', { dataDirMounted: null }, 'data_dir_not_mounted'],
    ['read-only disk', { dataDirReadOnly: true }, 'data_dir_read_only'],
    ['read-only unknown', { dataDirReadOnly: null }, 'data_dir_read_only'],
    ['database elsewhere', { databaseInsideDataDir: false }, 'database_outside_data_dir'],
    ['no backup key', { backupKeyValid: false }, 'backup_key'],
    ['no object store', { objectStoreValid: false }, 'object_store'],
    ['owner unreadable', { ownerExists: null }, 'owner_unreadable'],
    ['migrations unreadable', { migrationsPending: null }, 'migrations_unreadable'],
    ['migrations pending', { migrationsPending: 2 }, 'migrations_pending'],
  ];
  it.each(cases)('refuses to start: %s', (_name, change, code) => {
    const r = evaluateStartup({ ...GOOD, ...change });
    expect(r.ok).toBe(false);
    expect(r.failures.map((x) => x.code)).toContain(code);
    expect(r.failures.find((x) => x.code === code)?.message).toBe(STARTUP_MESSAGES[code]);
    expect(r.setupMode).toBe(false);
  });

  it('no owner yet is setup mode (web and worker off), not a crash loop', () => {
    expect(evaluateStartup({ ...GOOD, ownerExists: false })).toEqual({
      ok: true,
      failures: [],
      setupMode: true,
    });
  });
  it('setup mode never hides another problem', () => {
    const r = evaluateStartup({ ...GOOD, ownerExists: false, authSecretValid: false });
    expect(r.ok).toBe(false);
    expect(r.setupMode).toBe(false);
  });
  it('messages never contain a value', () => {
    for (const m of Object.values(STARTUP_MESSAGES)) expect(m).not.toMatch(/[A-Za-z0-9_-]{32,}/);
  });
});
