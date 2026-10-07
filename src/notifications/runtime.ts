import 'server-only';
import { createTelegramChannel } from '@/integrations/telegram/client';
import { getTelegramEnv } from '@/integrations/telegram/env';
import type { NotificationChannel } from '@/integrations/telegram/types';

/**
 * The real channel, built lazily from the environment. The token and chat id go into the adapter and
 * nowhere else: they are not returned, stored or shown. Without a valid setup the channel is null and
 * the rest of the app is unchanged.
 */
export interface ChannelRuntime {
  channel: NotificationChannel | null;
  /** True only when a usable token and chat id exist. */
  configured: boolean;
  /** A plain explanation when not configured. Never contains a value. */
  message: string | null;
}

export function getChannelRuntime(): ChannelRuntime {
  const env = getTelegramEnv();
  if (env.status !== 'ready') return { channel: null, configured: false, message: env.message };
  return {
    channel: createTelegramChannel({ token: env.token, chatId: env.chatId }),
    configured: true,
    message: null,
  };
}
