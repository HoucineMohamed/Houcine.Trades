import 'server-only';

/**
 * Who is calling? Used for rate limiting and for the log.
 *
 * IMPORTANT: Next.js only fills X-Forwarded-For when the header is MISSING, so a visitor can send
 * any value they like. It is therefore believed ONLY when TRUST_PROXY=true, which you set only
 * behind a reverse proxy you control (module 8). Otherwise every request counts as one source
 * ("direct"); the global limit still protects the login.
 */

export interface ClientInfo {
  /** Rate-limit key and log text. Never trusted input. */
  ip: string;
  userAgent: string;
}

export interface HeaderReader {
  get(name: string): string | null;
}

const IP_SHAPE = /^[0-9a-fA-F:.]{1,45}$/;

export function clientInfoFromHeaders(headers: HeaderReader, trustProxy: boolean): ClientInfo {
  let ip = 'direct';
  if (trustProxy) {
    // With one trusted proxy, the RIGHTMOST entry is the one the proxy itself added.
    const forwarded = (headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const last = forwarded.at(-1);
    ip = last && IP_SHAPE.test(last) ? last : 'unknown';
  }
  const userAgent = (headers.get('user-agent') ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 200);
  return { ip, userAgent };
}

export const sourceBucket = (client: ClientInfo) => `source:${client.ip}`;
export const GLOBAL_BUCKET = 'global';
