import fs from 'node:fs';
import path from 'node:path';
import { parseAnalystEnv } from '@/integrations/anthropic/env';

/**
 * `npm run ai:set-key`: puts ANTHROPIC_API_KEY into .env.
 *
 * The key is read WITHOUT echo from a real terminal (never from an argument, a pipe or a file), is
 * checked for the right shape, and is never printed: only its last 4 characters are shown as
 * confirmation. It is written only to a .env file that git is told to ignore.
 */

export interface KeyIo {
  readSecret(prompt: string): Promise<string>;
  print(line?: string): void;
}

const MAX_ATTEMPTS = 3;
const KEY_LINE = /^\s*ANTHROPIC_API_KEY\s*=/;

/** Does .gitignore (next to the .env file) ignore .env? A secret is never written where git could track it. */
export function envIsGitIgnored(envPath: string): boolean {
  const ignorePath = path.join(path.dirname(envPath), '.gitignore');
  if (!fs.existsSync(ignorePath)) return false;
  const name = path.basename(envPath);
  return fs
    .readFileSync(ignorePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === name || l === `/${name}` || l === `${name}*` || l === '.env*');
}

/** Returns the new file text: the key line replaced (or appended), every other line untouched. */
export function withKey(existing: string | null, key: string): string {
  if (existing === null || existing === '') return `ANTHROPIC_API_KEY=${key}\n`;
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  let replaced = false;
  const out: string[] = [];
  for (const line of lines) {
    if (KEY_LINE.test(line)) {
      if (!replaced) out.push(`ANTHROPIC_API_KEY=${key}`);
      replaced = true; // a duplicate line is dropped, so the old key cannot linger
    } else out.push(line);
  }
  if (!replaced) out.push(`ANTHROPIC_API_KEY=${key}`);
  return out.join(eol) + eol;
}

export function writeSecretFile(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { force: true }); // a stale file from an earlier run keeps its old permissions
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true }); // never leave a copy of the key behind
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600); // owner only; an error is reported
}

/** Returns the process exit code. */
export async function setKeyFlow(
  io: KeyIo,
  options: { envPath: string; argv: string[] },
): Promise<number> {
  if (options.argv.length > 0) {
    io.print('This command takes no arguments. The key is typed in a hidden prompt,');
    io.print('never given on the command line (it would stay in your shell history).');
    return 2;
  }
  if (!envIsGitIgnored(options.envPath)) {
    io.print(
      `Refusing to write: ${path.basename(options.envPath)} is not listed in .gitignore, so git could track a secret.`,
    );
    return 1;
  }
  io.print(
    'Set the Anthropic API key for the analyst. Nothing you type is shown or stored anywhere but .env.',
  );
  io.print(
    'Before you create a key, set a monthly spend limit in the Anthropic console (see docs/analyst.md).',
  );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const typed = (await io.readSecret('Paste the API key (hidden), then press Enter: ')).trim();
    const checked = parseAnalystEnv({ ANTHROPIC_API_KEY: typed });
    if (checked.status !== 'ready') {
      // The message names the problem and never repeats what was typed.
      io.print(
        `  - ${checked.status === 'no_key' ? 'Nothing was typed.' : checked.message.replace(/ The analyst is off.*$/, '')}`,
      );
      continue;
    }
    const existing = fs.existsSync(options.envPath)
      ? fs.readFileSync(options.envPath, 'utf8')
      : null;
    writeSecretFile(options.envPath, withKey(existing, checked.apiKey));
    io.print();
    io.print(
      `Saved to ${path.basename(options.envPath)}. The key ends in ...${checked.apiKey.slice(-4)}.`,
    );
    io.print('Restart the app (stop "npm run dev" and start it again) so it reads the key.');
    io.print(
      'Then open the Analyst page and switch on "Send journal data to the AI" if you want to use it.',
    );
    return 0;
  }
  io.print('Too many attempts. Nothing was changed.');
  return 1;
}
