import path from 'node:path';
import { NotATerminalError, PromptAbortedError, readHiddenLine } from '../auth/prompt';
import { setKeyFlow, type KeyIo } from './flows';

const io: KeyIo = {
  readSecret: readHiddenLine,
  print: (line = '') => console.log(line),
};

async function main(): Promise<number> {
  try {
    return await setKeyFlow(io, {
      envPath: path.resolve(process.cwd(), '.env'),
      argv: process.argv.slice(2),
    });
  } catch (error) {
    if (error instanceof NotATerminalError) {
      console.error(
        'This command must be run in an interactive terminal, because it asks for your API key there. ' +
          'The key is never read from arguments, environment variables, pipes or files.',
      );
    } else if (error instanceof PromptAbortedError) {
      console.error(error.message);
    } else {
      console.error('Error: the key could not be saved.'); // never the details: they could hold the key
    }
    return 1;
  }
}

void main().then((code) => process.exit(code));
