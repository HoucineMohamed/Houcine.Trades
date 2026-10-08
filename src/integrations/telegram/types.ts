import type { ChannelName, ErrorCode } from '@/domain/notifications/kinds';

/**
 * The ONE interface between the app and a message channel. Messages go OUT only: there is no way
 * to receive a command through it. (The pairing source below is used only by the one-time pairing
 * script and is never reachable from the web app.)
 */

export type SendResult =
  | { ok: true }
  | {
      ok: false;
      /** A short code only. Never a message, a URL, a request or a raw error: they can hold the token. */
      code: ErrorCode;
      /** How long the service asked us to wait (whole seconds), when it said so. */
      retryAfterS: number | null;
    };

export interface NotificationChannel {
  readonly name: ChannelName;
  /** Sends one plain-text message. Never throws: every problem is a SendResult. */
  send(text: string): Promise<SendResult>;
}

export interface PairingUpdate {
  updateId: number;
  /** Null when the update is not a message (it is then ignored). */
  chatId: number | null;
  chatType: string | null;
  text: string | null;
}

export type UpdatesResult = { ok: true; updates: PairingUpdate[] } | { ok: false; code: ErrorCode };

export interface PairingSource {
  /** Long polling. `offset` confirms every update below it. Never throws. */
  getUpdates(input: { offset: number | null; timeoutSec: number }): Promise<UpdatesResult>;
}
