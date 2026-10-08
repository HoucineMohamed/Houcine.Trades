import 'server-only';
import { EMPTY_SHA256, sha256Hex, signRequest } from './sigv4';

/**
 * The off-platform store for encrypted backups: any S3-compatible service (path-style addressing,
 * single PUT, no multipart: backups are small). Endpoint, region, bucket and keys come from the
 * environment, so the provider can be changed without changing code.
 *
 * Errors are SHORT CODES only. A raw fetch error, a URL or a response body is never kept: they can
 * hold the endpoint, a signature or a provider message. No retries here: the caller decides.
 */

export type StoreErrorCode =
  'network' | 'timeout' | 'denied' | 'not_found' | 'server' | 'bad_response' | 'too_large';

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(`object store: ${code}`);
    this.name = 'StoreError';
  }
}

export interface StoredObject {
  key: string;
  size: number;
}

export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  /** Throws StoreError('not_found') when the object does not exist. */
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<StoredObject[]>;
  /** Deleting something that is already gone is not an error. */
  delete(key: string): Promise<void>;
}

export interface StoreConfig {
  endpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Folder inside the bucket for our objects, without slashes at the ends. */
  prefix: string;
}

const PLACEHOLDER = /replace|change.?me|placeholder|your[-_ ]|insert|todo|xxxx/i;
const MAX_OBJECT_BYTES = 1024 * 1024 * 1024;
const MAX_LIST_PAGES = 50;

/** Null when anything is missing or invalid. Never says which value is wrong beyond the name. */
export function parseStoreConfig(env: Record<string, string | undefined>): StoreConfig | null {
  const get = (k: string) => (env[k] ?? '').trim();
  let endpoint: URL;
  try {
    endpoint = new URL(get('S3_ENDPOINT'));
  } catch {
    return null;
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== '/' && endpoint.pathname !== '') ||
    !endpoint.hostname.includes('.')
  ) {
    return null;
  }
  const region = get('S3_REGION');
  const bucket = get('S3_BUCKET');
  const accessKeyId = get('S3_ACCESS_KEY_ID');
  const secretAccessKey = get('S3_SECRET_ACCESS_KEY');
  const prefix = (get('S3_PREFIX') || 'backups').replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/i.test(region)) return null;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || PLACEHOLDER.test(bucket)) return null;
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(accessKeyId) || PLACEHOLDER.test(accessKeyId)) return null;
  if (secretAccessKey.length < 16 || secretAccessKey.length > 256 || /\s/.test(secretAccessKey)) {
    return null;
  }
  if (PLACEHOLDER.test(secretAccessKey)) return null;
  if (!/^[A-Za-z0-9._/-]{1,60}$/.test(prefix) || prefix.includes('..')) return null;
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, prefix };
}

/** The secret values of a configuration, for the log redactor. */
export const storeSecrets = (c: StoreConfig): string[] => [c.secretAccessKey, c.accessKeyId];

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export interface S3Options {
  fetchFn?: typeof fetch;
  clock?: () => Date;
  timeoutMs?: number;
}

export function createS3Store(cfg: StoreConfig, options: S3Options = {}): ObjectStore {
  const doFetch = options.fetchFn ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 120_000;

  const urlFor = (key: string | null, query?: Record<string, string>) => {
    const path = key === null ? '' : `/${key.split('/').map(encodeURIComponent).join('/')}`;
    const u = new URL(`/${cfg.bucket}${path}`, cfg.endpoint);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
    return u;
  };

  async function call(
    method: string,
    url: URL,
    body?: Buffer,
  ): Promise<{ status: number; body: Buffer }> {
    const payloadSha256 = body ? sha256Hex(body) : EMPTY_SHA256;
    const signed = signRequest({
      method,
      url,
      headers: { 'x-amz-content-sha256': payloadSha256 },
      payloadSha256,
      region: cfg.region,
      service: 's3',
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      now: clock(),
    }).headers;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: signed,
        body: body ? new Uint8Array(body) : undefined,
        redirect: 'error', // a redirect could carry the signed request somewhere else
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // The raw error is dropped on purpose: it may contain the URL.
      throw new StoreError(
        e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
          ? 'timeout'
          : 'network',
      );
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_OBJECT_BYTES) throw new StoreError('too_large');
    let data: Buffer;
    try {
      data = Buffer.from(await res.arrayBuffer());
    } catch {
      throw new StoreError('timeout');
    }
    if (data.length > MAX_OBJECT_BYTES) throw new StoreError('too_large');
    return { status: res.status, body: data };
  }

  const fail = (status: number): never => {
    if (status === 401 || status === 403) throw new StoreError('denied');
    if (status === 404) throw new StoreError('not_found');
    if (status >= 500 || status === 429 || status === 408) throw new StoreError('server');
    throw new StoreError('bad_response');
  };

  return {
    async put(key, body) {
      const r = await call('PUT', urlFor(key), body);
      if (r.status !== 200 && r.status !== 201) fail(r.status);
    },
    async get(key) {
      const r = await call('GET', urlFor(key));
      if (r.status !== 200) fail(r.status);
      return r.body;
    },
    async delete(key) {
      const r = await call('DELETE', urlFor(key));
      if (r.status !== 200 && r.status !== 204 && r.status !== 404) fail(r.status);
    },
    async list(prefix) {
      const out: StoredObject[] = [];
      let token: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const query: Record<string, string> = { 'list-type': '2', prefix: `${prefix}/` };
        if (token) query['continuation-token'] = token;
        const r = await call('GET', urlFor(null, query));
        if (r.status !== 200) fail(r.status);
        const xml = r.body.toString('utf8');
        // Anything that is not a ListBucketResult is a failure: it must never read as "no backups".
        if (!/<ListBucketResult[\s>]/.test(xml)) throw new StoreError('bad_response');
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1] ?? '')?.[1];
          const size = /<Size>(\d+)<\/Size>/.exec(m[1] ?? '')?.[1];
          if (key === undefined || size === undefined) throw new StoreError('bad_response');
          out.push({ key: unescapeXml(key), size: Number(size) });
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        token = truncated
          ? (/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null)
          : null;
        if (truncated && token === null) throw new StoreError('bad_response');
        if (!truncated) return out;
        token = unescapeXml(token ?? '');
      }
      throw new StoreError('bad_response'); // far too many pages: something is wrong
    },
  };
}
