import { checkHealth } from '@/hosting/health';
import { publicRoute } from '../_lib/guard-core';

// Always computed at request time, never at build time.
export const dynamic = 'force-dynamic';

/**
 * The platform's health check. PUBLIC on purpose (listed in the guard coverage test): it answers
 * "ok" or "not ok" and nothing else.
 */
export const GET = publicRoute(async () => {
  const ok = checkHealth();
  return new Response(ok ? 'ok' : 'not ok', {
    status: ok ? 200 : 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
});
