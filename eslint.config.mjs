import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const forbid = (...groups) => ({
  'no-restricted-imports': ['error', { patterns: groups }],
});

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts']),
  // Dependency rule: domain logic is pure. It must not import I/O layers, UI, or Node I/O.
  {
    files: ['src/domain/**/*.ts'],
    rules: forbid(
      { group: ['@/data/*', '@/data'], message: 'domain must stay pure: no data access.' },
      { group: ['@/integrations/*', '@/integrations'], message: 'domain must stay pure.' },
      { group: ['@/bots/*', '@/bots'], message: 'domain must stay pure.' },
      { group: ['@/app/*', '@/app'], message: 'domain must stay pure.' },
      {
        group: ['node:*', 'fs', 'path', 'better-sqlite3', 'drizzle-orm*'],
        message: 'domain must stay pure: no I/O.',
      },
    ),
  },
  // UI must go through domain/data, never talk to exchanges or bots directly. It also may not use
  // the low-level create/open functions: every trade enters the journal through the risk engine.
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/integrations/*', '@/bots/*'],
              message: 'UI must not import integrations or bots directly.',
            },
          ],
          paths: [
            {
              name: '@/data/trades',
              importNames: ['createTrade', 'createTradeIn', 'openTrade', 'openTradeIn'],
              message:
                'Use logTrade / openTradeChecked from @/data/journal: every trade must pass the risk engine.',
            },
            {
              name: '@/data/client',
              importNames: ['getDb', 'createDatabase', 'migrateDatabase'],
              message:
                'The database is only reachable through the guard context (ctx.db): see src/app/_lib/guard.tsx.',
            },
            {
              name: '@/domain/auth/stepup',
              importNames: ['issueFreshAuth'],
              message: 'Only src/auth may issue a step-up proof, after really checking a code.',
            },
          ],
        },
      ],
    },
  },
  // The one place in the UI that opens the database: the guard that checks the session first.
  {
    files: ['src/app/_lib/guard-core.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // Nothing outside src/auth (and tests) may mint a step-up proof.
  {
    files: [
      'src/data/**/*.ts',
      'src/integrations/**/*.ts',
      'src/bots/**/*.ts',
      'src/config/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/domain/auth/stepup',
              importNames: ['issueFreshAuth'],
              message: 'Only src/auth may issue a step-up proof, after really checking a code.',
            },
          ],
        },
      ],
    },
  },
]);
