import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A built-in check that no real-looking secret is committed. It does not replace gitleaks (see
 * docs/security.md); it runs in every `npm test`, needs no extra program, and has no allowlist
 * beyond two documented public values (the .env.example placeholder and the RFC 6238 test secret).
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');

interface Rule {
  name: string;
  pattern: RegExp;
}

// Patterns are assembled from pieces so this file never contains a secret-looking literal itself.
const RULES: Rule[] = [
  { name: 'private key block', pattern: new RegExp('-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----') },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    name: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/,
  },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Anthropic / OpenAI style key', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Telegram bot token', pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    // NAME = "long random-looking value" where NAME says it is a secret.
    name: 'secret-looking assignment',
    pattern:
      /\b[A-Z0-9_]*(?:SECRET|TOKEN|API_?KEY|PASSWORD|PRIVATE_?KEY)[A-Z0-9_]*\s*[=:]\s*["']?[A-Za-z0-9+/_=-]{32,}["']?/,
  },
];

/** Exception 1: the documented placeholder in .env.example (only in that file). */
const PLACEHOLDER = 'replace-with-the-output-of-the-generate-command-see-docs-security';
/** Exception 2: the PUBLIC test secret from RFC 6238 Appendix B ("12345678901234567890" in Base32). */
const RFC_6238_PUBLIC_TEST_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const SKIP_FILES = new Set(['package-lock.json']);
const SKIP_EXT = /\.(png|jpe?g|gif|ico|woff2?|pdf|db|sqlite)$/i;

export function scanText(file: string, text: string): string[] {
  const found: string[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const cleaned = (file === '.env.example' ? line.replaceAll(PLACEHOLDER, '') : line).replaceAll(
      RFC_6238_PUBLIC_TEST_SECRET,
      '',
    );
    for (const rule of RULES) {
      if (rule.pattern.test(cleaned)) found.push(`${file}:${i + 1}: ${rule.name}`);
    }
  });
  return found;
}

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

describe('no real-looking secret is committed', () => {
  it('scans every tracked text file', () => {
    const problems: string[] = [];
    let scanned = 0;
    for (const file of trackedFiles()) {
      if (SKIP_FILES.has(file) || SKIP_EXT.test(file)) continue;
      const full = path.join(ROOT, file);
      if (!fs.existsSync(full)) continue; // deleted in the working tree
      scanned += 1;
      problems.push(...scanText(file, fs.readFileSync(full, 'utf8')));
    }
    expect(scanned).toBeGreaterThan(50);
    expect(problems).toEqual([]);
  });

  it('never tracks a real .env file or a database', () => {
    const bad = trackedFiles().filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && f !== '.env.example');
    const dbs = trackedFiles().filter((f) => /\.(db|sqlite3?)(-wal|-shm|-journal)?$/.test(f));
    expect([...bad, ...dbs]).toEqual([]);
  });

  it('.env.example holds only placeholders', () => {
    const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const secretLines = text
      .split('\n')
      .filter((l) => /^\s*[A-Z_]*(SECRET|KEY|TOKEN|PASSWORD)[A-Z_]*\s*=/.test(l));
    // a secret line is either the documented placeholder or EMPTY (the analyst key is set by a script)
    for (const line of secretLines) {
      const value = line.slice(line.indexOf('=') + 1).trim();
      expect(value === '' || line.includes(PLACEHOLDER), line).toBe(true);
    }
  });
});

describe('the scanner itself catches secrets (so a pass means something)', () => {
  const fake = (n: number) => 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fG3hJ5kL7nP9'.repeat(2).slice(0, n);
  it.each([
    ['private key', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
    ['AWS key', 'key = AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['GitHub token', 'x = gh' + 'p_' + fake(36)],
    ['Anthropic-style key', 'k = sk-' + 'ant-' + fake(40)],
    ['assignment', 'AUTH_SECRET=' + fake(48)],
    ['assignment with quotes', 'const API_KEY = "' + fake(40) + '"'],
  ])('flags a %s', (_name, line) => {
    expect(scanText('src/x.ts', line)).not.toEqual([]);
  });
  it('allows only the two documented exceptions', () => {
    expect(
      scanText('src/auth/totp.test.ts', `const X_SECRET = '${RFC_6238_PUBLIC_TEST_SECRET}';`),
    ).toEqual([]);
    expect(scanText('.env.example', 'AUTH_SECRET=' + PLACEHOLDER)).toEqual([]);
    expect(scanText('src/x.ts', 'AUTH_SECRET=' + PLACEHOLDER)).not.toEqual([]);
    expect(scanText('.env.example', 'AUTH_SECRET=' + PLACEHOLDER + fake(40))).not.toEqual([]);
  });
  it('does not flag ordinary code', () => {
    expect(scanText('src/x.ts', 'const password = await readHiddenLine();')).toEqual([]);
    expect(scanText('src/x.ts', 'AUTH_SECRET: z.string().min(32)')).toEqual([]);
  });
});
