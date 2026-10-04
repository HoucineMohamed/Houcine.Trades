import { createInterface } from 'node:readline';

/**
 * Terminal input for the owner scripts.
 *
 * The password is read WITHOUT echo, one key at a time (raw mode), and is refused unless the
 * input is a real terminal: it can never come from a command argument, an environment variable,
 * a pipe or a file, so it cannot end up in your shell history, process list or logs.
 */

export interface KeyState {
  value: string;
  done: boolean;
  aborted: boolean;
}

/** Pure key handling (tested without a terminal). Handles Enter, Backspace, Ctrl+C, and pasted text. */
export function applyKeys(state: KeyState, chunk: string): KeyState {
  let { value, done, aborted } = state;
  for (const ch of Array.from(chunk)) {
    if (done || aborted) break;
    if (ch === '\u0003') {
      aborted = true; // Ctrl+C
    } else if (ch === '\r' || ch === '\n') {
      done = true;
    } else if (ch === '\u007f' || ch === '\b') {
      value = Array.from(value).slice(0, -1).join('');
    } else if (ch === '\u0015') {
      value = ''; // Ctrl+U clears the line
    } else if (ch === '\u001b') {
      break; // an escape sequence (arrow keys, etc.): ignore the rest of this chunk
    } else if (ch >= ' ') {
      value += ch;
    }
  }
  return { value, done, aborted };
}

export class PromptAbortedError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'PromptAbortedError';
  }
}

export class NotATerminalError extends Error {
  constructor() {
    super(
      'This command must be run in an interactive terminal, because it asks for your password there. ' +
        'The password is never read from arguments, environment variables, pipes or files.',
    );
    this.name = 'NotATerminalError';
  }
}

export function readHiddenLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function')
    return Promise.reject(new NotATerminalError());
  return new Promise((resolve, reject) => {
    let state: KeyState = { value: '', done: false, aborted: false };
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      state = applyKeys(state, chunk);
      if (state.aborted) {
        finish();
        reject(new PromptAbortedError());
      } else if (state.done) {
        finish();
        resolve(state.value);
      }
    };
    stdin.on('data', onData);
  });
}

/** A visible line (for confirmations such as typing RESET). */
export function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.reject(new NotATerminalError());
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once('SIGINT', () => {
      rl.close();
      reject(new PromptAbortedError());
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
