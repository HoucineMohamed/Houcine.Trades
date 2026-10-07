import 'server-only';
import { z } from 'zod';
import type { ErrorCode } from '@/domain/notifications/kinds';
import type {
  NotificationChannel,
  PairingSource,
  PairingUpdate,
  SendResult,
  UpdatesResult,
} from './types';

/**
 * The Telegram adapter: the Bot API over `fetch`, no dependency.
 *
 * !! The Bot API puts the TOKEN INSIDE THE REQUEST URL. So this file never logs, stores, throws or
 * returns a URL, a request object or a raw fetch error: every failure is reduced to a short code
 * (a test feeds it an error that contains the URL and checks nothing leaks).
 *
 * Fail closed: a reply that does not have exactly the expected shape is a failure ('bad_response'),
 * even with HTTP 200. Plain text only: no parse mode, no markup, no links, no buttons.
 *
 * Minimal API surface (sendMessage, getUpdates). Facts used here that were NOT confirmed against the
 * official docs in the build session are listed in docs/notifications.md ("to confirm on first live test").
 */

export const API_HOST = 'https://api.telegram.org';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface Reply {
  status: number;
  json: unknown;
}

type CallResult = { ok: true; reply: Reply } | { ok: false; code: ErrorCode };

async function call(
  token: string,
  method: 'sendMessage' | 'getUpdates',
  body: Record<string, unknown>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${API_HOST}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // A timeout while reading the body is a timeout (the message may have been delivered).
      if (controller.signal.aborted) return { ok: false, code: 'timeout' };
      json = null;
    }
    return { ok: true, reply: { status: response.status, json } };
  } catch {
    // The caught error may contain the URL (and so the token). It is dropped, never inspected.
    return { ok: false, code: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const replySchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  parameters: z.object({ retry_after: z.number().int().optional() }).passthrough().optional(),
});

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'bad_request';
  return 'bad_response';
}

function retryAfterOf(json: unknown): number | null {
  const parsed = replySchema.safeParse(json);
  const v = parsed.success ? parsed.data.parameters?.retry_after : undefined;
  return v !== undefined && v >= 1 && v <= 86_400 ? v : null;
}

/** Turns a reply into success or a short error code. Anything unexpected is 'bad_response'. */
function classify(
  reply: Reply,
  needResult: 'object' | 'array',
): { ok: true; result: unknown } | { ok: false; code: ErrorCode; retryAfterS: number | null } {
  const parsed = replySchema.safeParse(reply.json);
  if (reply.status < 200 || reply.status >= 300 || !parsed.success || !parsed.data.ok) {
    const byBodyCode =
      parsed.success && !parsed.data.ok && parsed.data.error_code !== undefined
        ? codeForStatus(parsed.data.error_code)
        : null;
    const code = reply.status >= 400 ? codeForStatus(reply.status) : (byBodyCode ?? 'bad_response');
    return {
      ok: false,
      code,
      retryAfterS: code === 'rate_limited' ? retryAfterOf(reply.json) : null,
    };
  }
  const result = parsed.data.result;
  const shapeOk =
    needResult === 'array'
      ? Array.isArray(result)
      : typeof result === 'object' && result !== null && !Array.isArray(result);
  return shapeOk ? { ok: true, result } : { ok: false, code: 'bad_response', retryAfterS: null };
}

export function createTelegramChannel(opts: {
  token: string;
  chatId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): NotificationChannel {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    name: 'telegram',
    async send(text): Promise<SendResult> {
      if (text.length < 1 || text.length > 4096)
        return { ok: false, code: 'bad_request', retryAfterS: null };
      const r = await call(
        opts.token,
        'sendMessage',
        // plain text: no parse_mode, no reply markup, nothing but the chat and the text
        { chat_id: Number(opts.chatId), text },
        fetchImpl,
        opts.timeoutMs ?? 10_000,
      );
      if (!r.ok) return { ok: false, code: r.code, retryAfterS: null };
      const c = classify(r.reply, 'object');
      return c.ok ? { ok: true } : { ok: false, code: c.code, retryAfterS: c.retryAfterS };
    },
  };
}

// ---- pairing (used by the one-time terminal script only) ------------------------------------------------

const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      chat: z.object({ id: z.number().int(), type: z.string() }),
      text: z.string().optional(),
    })
    .optional(),
});

export function createTelegramPairingSource(opts: {
  token: string;
  fetchImpl?: FetchLike;
}): PairingSource {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    async getUpdates({ offset, timeoutSec }): Promise<UpdatesResult> {
      const r = await call(
        opts.token,
        'getUpdates',
        {
          ...(offset === null ? {} : { offset }),
          timeout: timeoutSec,
          allowed_updates: ['message'],
        },
        fetchImpl,
        (timeoutSec + 10) * 1000,
      );
      if (!r.ok) return { ok: false, code: r.code };
      const c = classify(r.reply, 'array');
      if (!c.ok) return { ok: false, code: c.code };
      const updates: PairingUpdate[] = [];
      for (const raw of c.result as unknown[]) {
        const u = updateSchema.safeParse(raw);
        // ONE malformed update makes the whole reply unverified: pairing never accepts a guessed shape.
        if (!u.success) return { ok: false, code: 'bad_response' };
        updates.push({
          updateId: u.data.update_id,
          chatId: u.data.message?.chat.id ?? null,
          chatType: u.data.message?.chat.type ?? null,
          text: u.data.message?.text ?? null,
        });
      }
      return { ok: true, updates };
    },
  };
}
