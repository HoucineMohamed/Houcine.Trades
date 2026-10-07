import path from 'node:path';
import { logChannelChange } from '@/data/notifications';
import { createTelegramPairingSource } from '@/integrations/telegram/client';
import { NotATerminalError, PromptAbortedError, readHiddenLine, readLine } from '../auth/prompt';
import { loadEnvFile, openDatabase } from '../auth/run';
import { setTelegramFlow, type NotifyIo } from './flows';

const io: NotifyIo = {
  readSecret: readHiddenLine,
  readLine,
  print: (line = '') => console.log(line),
};

async function main(): Promise<number> {
  try {
    loadEnvFile();
    return await setTelegramFlow(io, {
      envPath: path.resolve(process.cwd(), '.env'),
      argv: process.argv.slice(2),
      makeSource: (token) => createTelegramPairingSource({ token }),
      logChange: () => logChannelChange(openDatabase(), 'channel_paired'),
    });
  } catch (error) {
    if (error instanceof NotATerminalError) {
      console.error(
        'This command must be run in an interactive terminal, because it asks for your bot token there. ' +
          'The token is never read from arguments, environment variables, pipes or files.',
      );
    } else if (error instanceof PromptAbortedError) {
      console.error(error.message);
    } else {
      console.error('Error: setting up Telegram failed.'); // never the details: they could hold the token
    }
    return 1;
  }
}

void main().then((code) => process.exit(code));
