import { describe, expect, it } from 'vitest';
import { EMPTY_SHA256, sha256Hex, signRequest } from './sigv4';

/**
 * Vectors from AWS's own documentation ("Signature Version 4 test suite" and the Amazon S3 API
 * reference, "Authenticating requests: using the Authorization header"). A 256-bit signature cannot
 * match by accident: if these pass, the canonical request, the string to sign and the key
 * derivation are all exactly what AWS computes. (The values were entered from the published
 * documentation; the build session could not re-open the AWS pages to re-check them.)
 */
const S3_KEY = 'AKIAIOSFODNN7EXAMPLE';
const S3_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const S3_NOW = new Date('2013-05-24T00:00:00Z');
const s3 = (over: Partial<Parameters<typeof signRequest>[0]>) =>
  signRequest({
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/'),
    headers: { 'x-amz-content-sha256': EMPTY_SHA256 },
    payloadSha256: EMPTY_SHA256,
    region: 'us-east-1',
    service: 's3',
    accessKeyId: S3_KEY,
    secretAccessKey: S3_SECRET,
    now: S3_NOW,
    ...over,
  });

describe('SigV4 against the published AWS examples', () => {
  it('test suite: get-vanilla', () => {
    const r = signRequest({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      payloadSha256: EMPTY_SHA256,
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(r.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(r.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('S3: GET Object with a Range header', () => {
    const r = s3({
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256 },
    });
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(r.headers.authorization).toContain(
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date',
    );
  });

  it('S3: PUT Object (a $ in the key, a storage class header, a body hash)', () => {
    const body = 'Welcome to Amazon S3.';
    expect(sha256Hex(body)).toBe(
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    );
    const r = s3({
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: {
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        'x-amz-content-sha256': sha256Hex(body),
      },
      payloadSha256: sha256Hex(body),
    });
    expect(r.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('S3: GET Bucket Lifecycle (a query parameter without a value)', () => {
    const r = s3({ url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle') });
    expect(r.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('S3: GET Bucket (List Objects) with sorted query parameters', () => {
    const r = s3({ url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J') });
    expect(r.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

describe('SigV4 properties', () => {
  it('the signature depends on every input', () => {
    const base = s3({});
    expect(s3({ now: new Date('2013-05-24T00:00:01Z') }).signature).not.toBe(base.signature);
    expect(s3({ region: 'eu-central-1' }).signature).not.toBe(base.signature);
    expect(s3({ secretAccessKey: `${S3_SECRET}x` }).signature).not.toBe(base.signature);
    expect(s3({ method: 'DELETE' }).signature).not.toBe(base.signature);
    expect(s3({ payloadSha256: sha256Hex('x') }).signature).not.toBe(base.signature);
  });
  it('the secret key is never part of what is sent', () => {
    expect(JSON.stringify(s3({}).headers)).not.toContain(S3_SECRET);
  });
});
