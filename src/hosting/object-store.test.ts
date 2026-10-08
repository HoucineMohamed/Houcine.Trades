import { describe, expect, it } from 'vitest';
import { createS3Store, parseStoreConfig, StoreError, type StoreConfig } from './object-store';

// test credentials are built at run time: no key-looking literal in the repository
const rnd = (n: number, salt: string) =>
  Array.from(
    { length: n },
    (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 11 + salt.length * 3) % 36],
  ).join('');
const ENV = {
  S3_ENDPOINT: 'https://objects.testhost.dev',
  S3_REGION: 'eu-test-1',
  S3_BUCKET: 'my-backups',
  S3_ACCESS_KEY_ID: `AK${rnd(16, 'a')}`,
  S3_SECRET_ACCESS_KEY: rnd(40, 'b'),
};
const cfg = parseStoreConfig(ENV) as StoreConfig;

describe('parseStoreConfig', () => {
  it('accepts a complete configuration', () => {
    expect(cfg.bucket).toBe('my-backups');
    expect(cfg.prefix).toBe('backups');
    expect(parseStoreConfig({ ...ENV, S3_PREFIX: '/team/hb/' })?.prefix).toBe('team/hb');
  });
  const bad: [string, Record<string, string>][] = [
    ['http endpoint', { S3_ENDPOINT: 'http://objects.testhost.dev' }],
    ['endpoint with credentials', { S3_ENDPOINT: 'https://u:p@objects.testhost.dev' }],
    ['endpoint with a path', { S3_ENDPOINT: 'https://objects.testhost.dev/bucket' }],
    ['endpoint with a query', { S3_ENDPOINT: 'https://objects.testhost.dev/?x=1' }],
    ['endpoint without a dot', { S3_ENDPOINT: 'https://localhost' }],
    ['not a url', { S3_ENDPOINT: 'nope' }],
    ['no region', { S3_REGION: '' }],
    ['bad bucket', { S3_BUCKET: 'Bad Bucket!' }],
    ['placeholder bucket', { S3_BUCKET: 'replace-with-your-bucket' }],
    ['short key id', { S3_ACCESS_KEY_ID: 'abc' }],
    ['short secret', { S3_SECRET_ACCESS_KEY: 'short' }],
    ['placeholder secret', { S3_SECRET_ACCESS_KEY: 'replace-with-your-secret-key-please' }],
    ['space in secret', { S3_SECRET_ACCESS_KEY: `${rnd(20, 'x')} ${rnd(20, 'y')}` }],
    ['prefix with ..', { S3_PREFIX: 'a/../b' }],
  ];
  it.each(bad)('refuses %s', (_n, change) => {
    expect(parseStoreConfig({ ...ENV, ...change })).toBeNull();
  });
  it('refuses when anything is missing', () => {
    for (const k of Object.keys(ENV)) {
      const copy: Record<string, string | undefined> = { ...ENV };
      delete copy[k];
      expect(parseStoreConfig(copy), k).toBeNull();
    }
  });
});

function fakeFetch(
  handler: (req: {
    method: string;
    url: URL;
    headers: Headers;
    body: Buffer | null;
  }) => Response | Promise<Response>,
) {
  const seen: { method: string; url: string; headers: Headers; redirect: string | undefined }[] =
    [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({
      method: init?.method ?? 'GET',
      url: url.toString(),
      headers,
      redirect: init?.redirect,
    });
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : null;
    return handler({ method: init?.method ?? 'GET', url, headers, body });
  }) as typeof fetch;
  return { fn, seen };
}
const NOW = new Date('2026-10-08T03:00:00Z');
const store = (f: typeof fetch) =>
  createS3Store(cfg, { fetchFn: f, clock: () => NOW, timeoutMs: 1000 });

describe('S3 client', () => {
  it('PUT: path-style URL, signed, hash of the body, no redirects', async () => {
    const { fn, seen } = fakeFetch(() => new Response('', { status: 200 }));
    await store(fn).put('backups/20261008T030000Z-daily-m5.htbk', Buffer.from('hello'));
    const r = seen[0];
    expect(r?.method).toBe('PUT');
    expect(r?.url).toBe(
      'https://objects.testhost.dev/my-backups/backups/20261008T030000Z-daily-m5.htbk',
    );
    expect(r?.redirect).toBe('error');
    expect(r?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=.*\/20261008\/eu-test-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(r?.headers.get('x-amz-content-sha256')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(JSON.stringify([...(r?.headers ?? [])])).not.toContain(ENV.S3_SECRET_ACCESS_KEY);
  });

  it('GET returns the bytes; 404 is not_found; 403 is denied; 500 is server', async () => {
    const mk = (status: number) => store(fakeFetch(() => new Response('x', { status })).fn);
    const ok = store(fakeFetch(() => new Response(Buffer.from('data'), { status: 200 })).fn);
    expect((await ok.get('k')).toString()).toBe('data');
    await expect(mk(404).get('k')).rejects.toMatchObject({ code: 'not_found' });
    await expect(mk(403).get('k')).rejects.toMatchObject({ code: 'denied' });
    await expect(mk(401).get('k')).rejects.toMatchObject({ code: 'denied' });
    await expect(mk(503).get('k')).rejects.toMatchObject({ code: 'server' });
    await expect(mk(429).get('k')).rejects.toMatchObject({ code: 'server' });
    await expect(mk(418).get('k')).rejects.toMatchObject({ code: 'bad_response' });
    await expect(mk(301).get('k')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('a network error becomes a short code that does not contain the URL or the key', async () => {
    const f = fakeFetch(() => {
      throw new TypeError(`fetch failed: ${cfg.endpoint.href}${ENV.S3_SECRET_ACCESS_KEY}`);
    });
    const e = await store(f.fn)
      .put('k', Buffer.from('x'))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe('network');
    expect(String((e as Error).message) + String((e as Error).stack)).not.toContain('testhost');
    expect(String((e as Error).stack)).not.toContain(ENV.S3_SECRET_ACCESS_KEY);
  });

  it('a timeout is reported as a timeout', async () => {
    const f = fakeFetch(() => {
      const e = new Error('slow');
      e.name = 'TimeoutError';
      throw e;
    });
    await expect(store(f.fn).get('k')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('DELETE of something already gone is fine', async () => {
    const s = store(fakeFetch(() => new Response('', { status: 404 })).fn);
    await expect(s.delete('k')).resolves.toBeUndefined();
  });

  it('LIST parses keys, pages, and XML escapes', async () => {
    let page = 0;
    const f = fakeFetch(({ url }) => {
      page += 1;
      expect(url.searchParams.get('list-type')).toBe('2');
      expect(url.searchParams.get('prefix')).toBe('backups/');
      if (page === 1) {
        return new Response(
          '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken><Contents><Key>backups/a&amp;b.htbk</Key><Size>10</Size></Contents></ListBucketResult>',
        );
      }
      expect(url.searchParams.get('continuation-token')).toBe('tok&1');
      return new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>backups/c.htbk</Key><Size>20</Size></Contents></ListBucketResult>',
      );
    });
    expect(await store(f.fn).list('backups')).toEqual([
      { key: 'backups/a&b.htbk', size: 10 },
      { key: 'backups/c.htbk', size: 20 },
    ]);
  });

  it('LIST never reads a malformed or foreign answer as "no backups"', async () => {
    for (const body of [
      '',
      '<html>captive portal</html>',
      '{"ok":true}',
      '<Error><Code>X</Code></Error>',
    ]) {
      const s = store(fakeFetch(() => new Response(body, { status: 200 })).fn);
      await expect(s.list('backups'), body).rejects.toMatchObject({ code: 'bad_response' });
    }
    const truncatedNoToken = store(
      fakeFetch(
        () => new Response('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>'),
      ).fn,
    );
    await expect(truncatedNoToken.list('backups')).rejects.toMatchObject({ code: 'bad_response' });
    const missingSize = store(
      fakeFetch(
        () =>
          new Response('<ListBucketResult><Contents><Key>k</Key></Contents></ListBucketResult>'),
      ).fn,
    );
    await expect(missingSize.list('backups')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('an object that declares a huge size is refused before it is read', async () => {
    const s = store(
      fakeFetch(
        () =>
          new Response('x', { status: 200, headers: { 'content-length': String(5 * 1024 ** 3) } }),
      ).fn,
    );
    await expect(s.get('k')).rejects.toMatchObject({ code: 'too_large' });
  });
});
