import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guards on the container files. (The container itself is built and run by
 * scripts/ci/container-smoke.sh, in CI, with decoy files planted to prove none reach the image.)
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const lines = (f: string) =>
  read(f)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

describe('.dockerignore keeps private and local files out of the image', () => {
  const rules = lines('.dockerignore');
  it.each([
    '.env',
    '.env.*',
    'data',
    '**/*.db',
    '**/*.db-*',
    '**/*.sqlite',
    '.git',
    'node_modules',
    '.next',
    'tests',
    '**/*.pem',
    '**/*.key',
  ])('excludes %s', (rule) => {
    expect(rules).toContain(rule);
  });
  it('re-includes nothing except the placeholder template', () => {
    expect(rules.filter((r) => r.startsWith('!'))).toEqual(['!.env.example']);
  });
  it('does not exclude src/data (it is code: only the top-level data folder is excluded)', () => {
    expect(rules).not.toContain('**/data');
  });
  it('does not exclude what the app needs at run time', () => {
    for (const needed of ['src', 'scripts', 'drizzle', 'docs', 'package.json', 'next.config.ts']) {
      expect(rules, needed).not.toContain(needed);
    }
  });
});

describe('Dockerfile', () => {
  const text = read('Dockerfile');
  const nvm = read('.nvmrc').trim();

  it('uses exact, digest-pinned base images that match .nvmrc (Node 22)', () => {
    const images = [...text.matchAll(/^ARG (?:BUILD_IMAGE|NODE_IMAGE)=(\S+)$/gm)].map((m) => m[1]);
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image).toMatch(
        new RegExp(`^node:${nvm}\\.\\d+\\.\\d+-bookworm(-slim)?@sha256:[0-9a-f]{64}$`),
      );
    }
    expect(text).not.toMatch(/:latest\b/);
  });
  it('installs from the lockfile and ships no dev dependencies', () => {
    expect(text).toContain('RUN npm ci');
    expect(text).toContain('npm prune --omit=dev');
    expect(text).not.toMatch(/npm install\b/);
  });
  it('the final image copies nothing private (no .env, no data, no database)', () => {
    const runtime = text.slice(text.indexOf('AS runtime'));
    const copies = runtime.split('\n').filter((l) => l.startsWith('COPY'));
    expect(copies.length).toBeGreaterThan(5);
    for (const line of copies) {
      expect(line, line).not.toMatch(/\.env|\.db\b|\bdata\b|COPY (--\S+ )*\. /);
    }
  });
  it('sets no secret in the image (secrets come from the platform at run time)', () => {
    expect(text).not.toMatch(/ENV[^\n]*(AUTH_SECRET|BACKUP_KEY|S3_SECRET|TOKEN|PASSWORD|API_KEY)/i);
    expect(text).not.toMatch(/ARG[^\n]*(SECRET|TOKEN|PASSWORD|KEY=)/i);
  });
  it('is hosted, production, has a health check, and runs through the entrypoint', () => {
    expect(text).toContain('HOSTED=true');
    expect(text).toContain('NODE_ENV=production');
    expect(text).toContain('HEALTHCHECK');
    expect(text).toContain('ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]');
    expect(text).toContain('scripts/host/start.ts');
  });
});

describe('docker-entrypoint.sh', () => {
  const text = read('docker-entrypoint.sh');
  it('drops to the unprivileged node user for good, and never runs the app as root', () => {
    expect(text).toContain('setpriv --reuid=node --regid=node --init-groups');
    expect(text).toMatch(/exec setpriv/);
    expect(text).toMatch(/^set -eu$/m);
  });
  it('only changes the owner of the data folder, without following links', () => {
    expect(text).toContain('chown -R -h node:node "$DATA_DIR"');
    expect(text).not.toMatch(/chmod\s+-?R?\s*777|chmod 777/);
  });
  it('is executable', () => {
    expect(fs.statSync(path.join(ROOT, 'docker-entrypoint.sh')).mode & 0o111).not.toBe(0);
  });
});

describe('package.json and CI', () => {
  const pkg = JSON.parse(read('package.json')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  it('tsx (which runs the scripts) is a production dependency, so the image needs no dev dependencies', () => {
    expect(pkg.dependencies.tsx).toBeDefined();
    expect(pkg.devDependencies.tsx).toBeUndefined();
  });
  it('the local start still binds to 127.0.0.1 only (the container binds elsewhere on its own)', () => {
    expect(pkg.scripts.start).toBe('next start -H 127.0.0.1');
    expect(pkg.scripts.dev).toContain('-H 127.0.0.1');
  });
  it('has the host scripts', () => {
    for (const s of [
      'host:start',
      'host:check',
      'host:backup',
      'host:restore',
      'backup:generate-key',
    ]) {
      expect(pkg.scripts[s], s).toContain('tsx');
    }
  });
  it('CI builds the image and runs the smoke test, and keeps the secret scan', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('bash scripts/ci/container-smoke.sh');
    expect(ci).toContain('gitleaks');
    expect(ci).toContain('npm run db:generate');
  });
  it('the smoke test script plants decoys and checks the main promises', () => {
    const smoke = read('scripts/ci/container-smoke.sh');
    for (const must of [
      'smoke-decoy',
      'exit 78',
      'strict-transport-security',
      '/proc/1/status',
      'supervisor.stopped',
      'secret value appears in the log',
    ]) {
      expect(smoke, must).toContain(must.replace('exit 78', '78'));
    }
  });
});
