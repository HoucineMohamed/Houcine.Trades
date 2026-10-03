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
  // UI must go through domain/data, never talk to exchanges or bots directly.
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: forbid({
      group: ['@/integrations/*', '@/bots/*'],
      message: 'UI must not import integrations or bots directly.',
    }),
  },
]);
