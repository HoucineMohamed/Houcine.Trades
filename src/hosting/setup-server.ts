import 'server-only';
import http from 'node:http';

/**
 * Shown while no owner exists yet. The web app and the worker are NOT running; this tiny server
 * answers only the platform's health check, so the container stays up and you can open the shell to
 * create the owner. Everything else gets a plain 503. It never serves a page, takes no input and
 * reads no cookie.
 */

export function setupResponse(
  method: string | undefined,
  url: string | undefined,
): { status: number; body: string } {
  if (method === 'GET' && url === '/healthz') return { status: 200, body: 'ok' };
  return { status: 503, body: 'setup not finished' };
}

export interface SetupServer {
  close(): Promise<void>;
  port(): number;
}

export function startSetupServer(options: { port: number; host: string }): Promise<SetupServer> {
  const server = http.createServer((req, res) => {
    const r = setupResponse(req.method, req.url);
    res.writeHead(r.status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(r.body);
    req.resume();
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  let closing: Promise<void> | null = null;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      resolve({
        port: () => {
          const a = server.address();
          return typeof a === 'object' && a ? a.port : options.port;
        },
        close: () => {
          closing ??= new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          });
          return closing; // closing twice is the same as closing once
        },
      });
    });
  });
}
