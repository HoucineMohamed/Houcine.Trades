import 'server-only';
import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 request signing, written out in full (no dependency). It is tested against
 * the signatures AWS publishes for its own examples (src/hosting/sigv4.test.ts), so a mistake here
 * shows up as a mismatch, not as a mystery "access denied" on the first real upload.
 *
 * Only what S3-compatible storage needs: header-based signing with a payload hash.
 */

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 percent-encoding: only A-Z a-z 0-9 - _ . ~ stay as they are. */
const uriEncode = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function canonicalPath(pathname: string): string {
  // Each path segment is decoded then encoded once (S3 style: no double encoding, no normalising).
  return (
    pathname
      .split('/')
      .map((seg) => uriEncode(decodeURIComponent(seg)))
      .join('/') || '/'
  );
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([uriEncode(k), uriEncode(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export interface SignInput {
  method: string;
  url: URL;
  /** Extra headers to sign (lower or mixed case). host and x-amz-date are added for you. */
  headers: Record<string, string>;
  payloadSha256: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

export interface Signed {
  /** All headers to send: yours, host, x-amz-date and authorization. */
  headers: Record<string, string>;
  /** For tests: the hex signature. */
  signature: string;
}

const amzDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

export function signRequest(i: SignInput): Signed {
  const date = amzDate(i.now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v;
  headers.host = i.url.host;
  headers['x-amz-date'] = date;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${(headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    i.method.toUpperCase(),
    canonicalPath(i.url.pathname),
    canonicalQuery(i.url),
    canonicalHeaders,
    signedHeaders,
    i.payloadSha256,
  ].join('\n');

  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${i.secretAccessKey}`, day);
  const kRegion = hmac(kDate, i.region);
  const kService = hmac(kRegion, i.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, signature };
}
