import { randomBytes, randomInt } from 'node:crypto';
import type {
  NotificationChannel,
  PairingSource,
  PairingUpdate,
  SendResult,
  UpdatesResult,
} from '@/integrations/telegram/types';

/** Test secrets are built at RUN time, so no token-looking literal lives in the repository. */
export const fakeBotToken = (): string =>
  `${randomInt(100_000_000, 999_999_999)}:${randomBytes(24).toString('hex')}`;
export const fakeChatId = (): string => String(randomInt(100_000_000, 999_999_999));

export type SendScript = SendResult | Error | ((text: string, n: number) => SendResult);

export interface FakeChannel extends NotificationChannel {
  /** Every text it was asked to send, in order. */
  sent: string[];
  calls: number;
}

/**
 * The fake channel every notification test uses: the SAME interface as the real adapter, no
 * network. `script` may be one result, a function, an Error (a misbehaving adapter that THROWS,
 * which the real one never does), or a list used in turn (the last one repeats).
 */
export function fakeChannel(script: SendScript | SendScript[] = { ok: true }): FakeChannel {
  const list = Array.isArray(script) ? script : [script];
  const ch: FakeChannel = {
    name: 'fake',
    sent: [],
    calls: 0,
    async send(text) {
      const entry = list[Math.min(ch.calls, list.length - 1)] as SendScript;
      ch.calls += 1;
      ch.sent.push(text);
      if (entry instanceof Error) throw entry;
      return typeof entry === 'function' ? entry(text, ch.calls) : entry;
    },
  };
  return ch;
}

export const failSend = (
  code: Extract<SendResult, { ok: false }>['code'],
  retryAfterS: number | null = null,
): SendResult => ({
  ok: false,
  code,
  retryAfterS,
});

/** A fake source of Telegram updates for the pairing tests. */
export function fakePairingSource(
  batches: (PairingUpdate[] | { code: Extract<UpdatesResult, { ok: false }>['code'] })[],
): PairingSource & { requests: { offset: number | null; timeoutSec: number }[] } {
  const requests: { offset: number | null; timeoutSec: number }[] = [];
  let i = 0;
  return {
    requests,
    async getUpdates(input) {
      requests.push(input);
      const b = batches[Math.min(i, batches.length - 1)];
      i += 1;
      if (b === undefined) return { ok: true, updates: [] };
      if (!Array.isArray(b)) return { ok: false, code: b.code };
      // like the real service: only updates the caller has not confirmed yet
      return {
        ok: true,
        updates: b.filter((u) => input.offset === null || u.updateId >= input.offset),
      };
    },
  };
}

export const msg = (
  updateId: number,
  chatId: number,
  text: string | null,
  chatType = 'private',
): PairingUpdate => ({
  updateId,
  chatId,
  chatType,
  text,
});
