import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chatIdSchema, tokenSchema } from '@/integrations/telegram/env';
import type { PairingSource, PairingUpdate } from '@/integrations/telegram/types';
import { envIsGitIgnored, writeSecretFile } from '../ai/flows';

/**
 * `npm run notify:set-telegram`: puts TELEGRAM_BOT_TOKEN into .env (hidden input, never printed,
 * only its last 4 characters shown) and PAIRS the chat: it shows a one-time random code, you send
 * that code to your bot, and the chat id is read from THAT message only.
 *
 * Pairing is the only time incoming messages are read, and only to find the code. Everything else
 * is ignored: other texts, other senders, groups, anything that looks like a command. A reply that
 * does not have exactly the expected shape stops the pairing (nothing is guessed).
 */

export interface NotifyIo {
  readSecret(prompt: string): Promise<string>;
  readLine(prompt: string): Promise<string>;
  print(line?: string): void;
}

export interface SetTelegramOptions {
  envPath: string;
  argv: string[];
  makeSource: (token: string) => PairingSource;
  /** Records a channel change in the authentication log (best effort, never needed for pairing). */
  logChange?: (detail: 'channel_token_changed' | 'channel_paired') => void;
  /** Tests: the one-time code, the clock, the pause. */
  makeCode?: () => string;
  now?: () => number;
  /** How long to wait for the code, in total. */
  totalMs?: number;
  /** One long-poll, in seconds. */
  pollSec?: number;
}

const MAX_ATTEMPTS = 3;
const ENV_LINE = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);

/** Replaces, appends or (with null) removes one KEY=value line; every other line is untouched. */
export function withEnvValue(existing: string | null, key: string, value: string | null): string {
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  const lines = (existing ?? '').split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const out: string[] = [];
  let done = false;
  for (const line of lines) {
    if (ENV_LINE(key).test(line)) {
      if (!done && value !== null) out.push(`${key}=${value}`);
      done = true; // a duplicate line is dropped
    } else out.push(line);
  }
  if (!done && value !== null) out.push(`${key}=${value}`);
  return out.length === 0 ? '' : out.join(eol) + eol;
}

function updateEnv(envPath: string, changes: Record<string, string | null>): void {
  let text: string | null = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null;
  for (const [k, v] of Object.entries(changes)) text = withEnvValue(text, k, v);
  writeSecretFile(envPath, text ?? '');
}

/** No ambiguous characters (0/O, 1/I). Example: HT-7KQ2-M9XP */
export function newPairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n: number) =>
    Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `HT-${pick(4)}-${pick(4)}`;
}

const REASONS: Record<string, string> = {
  unauthorized: 'Telegram did not accept the token (it may be mistyped or revoked).',
  conflict:
    'Telegram reports a conflict. A bot with a webhook set cannot be paired this way; remove the webhook first (see docs/notifications.md).',
  timeout: 'Telegram did not answer in time.',
  network: 'Telegram could not be reached.',
  rate_limited: 'Telegram asked us to slow down. Try again in a minute.',
  bad_response:
    'Telegram answered in a form that could not be verified, so pairing stopped. Nothing was trusted.',
};
const reason = (code: string) => REASONS[code] ?? 'Telegram refused the request.';

/** A message counts only if it is a PRIVATE chat and says exactly the code (or "/start <code>"). */
function isCode(u: PairingUpdate, code: string): boolean {
  if (u.chatType !== 'private' || u.chatId === null || u.chatId <= 0 || u.text === null)
    return false;
  const t = u.text.trim();
  return t === code || t === `/start ${code}`;
}

export async function setTelegramFlow(io: NotifyIo, o: SetTelegramOptions): Promise<number> {
  if (o.argv.length > 0) {
    io.print('This command takes no arguments. The token is typed in a hidden prompt,');
    io.print('never given on the command line (it would stay in your shell history).');
    return 2;
  }
  if (!envIsGitIgnored(o.envPath)) {
    io.print(
      `Refusing to write: ${path.basename(o.envPath)} is not listed in .gitignore, so git could track a secret.`,
    );
    return 1;
  }
  const now = o.now ?? Date.now;
  const totalMs = o.totalMs ?? 120_000;
  const pollSec = o.pollSec ?? 20;

  io.print('Set up Telegram alerts. Nothing you type is shown or stored anywhere but .env.');
  io.print(
    'Create your bot with @BotFather first, then press Start in the chat with it (see docs/notifications.md).',
  );

  // ---- 1. the token --------------------------------------------------------------------------
  let token: string | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && token === null; attempt++) {
    const typed = (await io.readSecret('Paste the bot token (hidden), then press Enter: ')).trim();
    const checked = tokenSchema.safeParse(typed);
    if (checked.success) token = checked.data;
    else
      io.print(
        `  - ${typed === '' ? 'Nothing was typed.' : (checked.error.issues[0]?.message ?? 'That is not a bot token') + '.'}`,
      );
  }
  if (token === null) {
    io.print('Too many attempts. Nothing was changed.');
    return 1;
  }
  // The token is saved; an older chat id belongs to the old setup, so it is removed until pairing succeeds.
  const hadChat = (fs.existsSync(o.envPath) ? fs.readFileSync(o.envPath, 'utf8') : '')
    .split(/\r?\n/)
    .some((l) => ENV_LINE('TELEGRAM_CHAT_ID').test(l));
  updateEnv(o.envPath, { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: null });
  io.print(`Token saved. It ends in ...${token.slice(-4)}.`);
  if (hadChat)
    io.print(
      'The previously paired chat was removed: alerts cannot be sent until pairing finishes.',
    );
  try {
    o.logChange?.('channel_token_changed'); // logged when it happens, even if pairing does not finish
  } catch {
    io.print('(The change could not be written to the sign-in log. Alerts are not affected.)');
  }

  // ---- 2. pairing ------------------------------------------------------------------------------
  const source = o.makeSource(token);
  // Throw away everything that is already waiting: only a message sent from now on can pair.
  let offset: number | null = null;
  for (let i = 0; i < 5; i++) {
    const r = await source.getUpdates({ offset, timeoutSec: 0 });
    if (!r.ok) {
      io.print(reason(r.code));
      io.print('The token is saved, but no chat is paired yet. Run this command again.');
      return 1;
    }
    if (r.updates.length === 0) break;
    offset = Math.max(...r.updates.map((u) => u.updateId)) + 1;
  }

  const code = (o.makeCode ?? newPairingCode)();
  io.print();
  io.print(
    'Now open the chat with your bot in Telegram and send exactly this code (nothing else):',
  );
  io.print();
  io.print(`    ${code}`);
  io.print();
  io.print(`Waiting up to ${Math.round(totalMs / 1000)} seconds. Other messages are ignored.`);

  const deadline = now() + totalMs;
  let chatId: number | null = null;
  let acceptedUpdate = 0;
  while (chatId === null) {
    const remainingSec = Math.floor((deadline - now()) / 1000);
    if (remainingSec <= 0) {
      io.print('Timed out. No chat was paired.');
      io.print('The token is saved. Run this command again to pair.');
      return 1;
    }
    const r = await source.getUpdates({ offset, timeoutSec: Math.min(pollSec, remainingSec) });
    if (!r.ok) {
      io.print(reason(r.code));
      io.print('The token is saved, but no chat is paired yet. Run this command again.');
      return 1;
    }
    if (r.updates.length > 0) offset = Math.max(...r.updates.map((u) => u.updateId)) + 1;
    const matches = r.updates.filter((u) => isCode(u, code));
    const chats = new Set(matches.map((u) => u.chatId));
    if (chats.size > 1) {
      io.print('Two different chats sent the code. That should not happen, so nothing was paired.');
      return 1;
    }
    const first = matches[0];
    if (first && first.chatId !== null) {
      chatId = first.chatId;
      acceptedUpdate = first.updateId;
    }
  }
  // Confirm the message with Telegram so it is not delivered again (the result does not matter).
  await source.getUpdates({ offset: acceptedUpdate + 1, timeoutSec: 0 });

  // ---- 3. confirm by the last digits only -----------------------------------------------------------
  const idText = String(chatId);
  io.print();
  io.print(`The code arrived from a private chat whose number ends in ...${idText.slice(-3)}.`);
  const answer = (await io.readLine('Is that your chat? Type YES to save it: ')).trim();
  if (answer !== 'YES') {
    io.print('Nothing was saved for the chat. Run this command again to pair.');
    return 1;
  }
  const parsed = chatIdSchema.safeParse(idText);
  if (!parsed.success) {
    io.print('That chat cannot be used (only private chats are allowed). Nothing was saved.');
    return 1;
  }
  updateEnv(o.envPath, { TELEGRAM_CHAT_ID: parsed.data });
  try {
    o.logChange?.('channel_paired');
  } catch {
    io.print('(The change could not be written to the sign-in log. Alerts are not affected.)');
  }
  io.print(`Paired. The chat ends in ...${idText.slice(-3)}.`);
  io.print(
    'Alerts stay OFF until you switch them on at the Alerts page (it needs your authenticator code).',
  );
  io.print('Restart the app and the worker so they read the new settings.');
  return 0;
}
