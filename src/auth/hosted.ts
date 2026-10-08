/**
 * Is this the hosted app (HOSTED=true, set only in the platform's environment)? Kept free of any
 * import so the proxy can use it too.
 *
 * When hosted, every request counts as HTTPS: the platform serves only HTTPS, so cookies are always
 * Secure with the __Host- prefix, and HSTS is always sent. A client cannot make the app believe a
 * request was plain http (or the opposite) by sending a header.
 */
export const isHosted = (env: Record<string, string | undefined> = process.env): boolean =>
  env.HOSTED === 'true';
