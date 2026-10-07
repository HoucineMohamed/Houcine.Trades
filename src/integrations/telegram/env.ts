import 'server-only';
import { z } from 'zod';

/**
 * Settings of the Telegram channel, validated with zod and read lazily (like AUTH_SECRET). Builds,
 * tests and the db:* commands never need them. Missing means "alerts cannot be switched on". No
 * message here ever echoes a value.
 *
 * The token shape ("digits:letters") is the documented BotFather form, but it was NOT confirmed
 * against Telegram's current docs in the build session: see docs/notifications.md.
 */

const PLACEHOLDER =
  /replace|change.?me|placeholder|example|your[-_ ]|insert|todo|token.?here|xxxx/i;

export const tokenSchema = z
  .string()
  .trim()
  .refine((v) => !PLACEHOLDER.test(v), 'TELEGRAM_BOT_TOKEN still looks like a placeholder')
  .refine(
    (v) => /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(v),
    'TELEGRAM_BOT_TOKEN does not look like a bot token (digits, a colon, then letters and digits)',
  );

/** A private chat id is a positive whole number. Groups and channels (negative) are refused. */
export const chatIdSchema = z
  .string()
  .trim()
  .refine((v) => /^\d{5,15}$/.test(v), 'TELEGRAM_CHAT_ID must be the number of a private chat');

export type TelegramEnv =
  | { status: 'ready'; token: string; chatId: string }
  | { status: 'not_configured'; message: string }
  | { status: 'invalid'; message: string };

export function parseTelegramEnv(source: Record<string, string | undefined>): TelegramEnv {
  const rawToken = source.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const rawChat = source.TELEGRAM_CHAT_ID?.trim() ?? '';
  if (rawToken === '' || rawChat === '') {
    return {
      status: 'not_configured',
      message:
        'Telegram is not set up. Run "npm run notify:set-telegram" (see docs/notifications.md).',
    };
  }
  const token = tokenSchema.safeParse(rawToken);
  if (!token.success)
    return {
      status: 'invalid',
      message: `${token.error.issues[0]?.message ?? 'The token is not valid'}.`,
    };
  const chat = chatIdSchema.safeParse(rawChat);
  if (!chat.success)
    return {
      status: 'invalid',
      message: `${chat.error.issues[0]?.message ?? 'The chat id is not valid'}.`,
    };
  return { status: 'ready', token: token.data, chatId: chat.data };
}

export const getTelegramEnv = (): TelegramEnv => parseTelegramEnv(process.env);
