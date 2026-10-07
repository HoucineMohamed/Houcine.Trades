import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotATerminalError, readHiddenLine } from '../../scripts/auth/prompt';
import { envIsGitIgnored, setKeyFlow, withKey, type KeyIo } from '../../scripts/ai/flows';
import { fakeApiKey } from '../helpers/analyst';

/** A fake terminal: answers come from a queue, everything printed is captured. */
function fakeIo(secrets: (string | Error)[]) {
  const out: string[] = [];
  const asked: string[] = [];
  const io: KeyIo = {
    readSecret: async (prompt) => {
      asked.push(prompt);
      const v = secrets.shift();
      if (v === undefined) throw new Error('unexpected prompt');
      if (v instanceof Error) throw v;
      return v;
    },
    print: (line = '') => void out.push(line),
  };
  return { io, text: () => out.join('\n'), asked };
}

let dir = '';
let envPath = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-setkey-'));
  envPath = path.join(dir, '.env');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n.env.*\n!.env.example\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('npm run ai:set-key', () => {
  it('writes the key to a new .env, shows only the last 4 characters, never prints the key', async () => {
    const key = fakeApiKey();
    const t = fakeIo([key]);
    expect(await setKeyFlow(t.io, { envPath, argv: [] })).toBe(0);
    expect(fs.readFileSync(envPath, 'utf8')).toBe(`ANTHROPIC_API_KEY=${key}\n`);
    expect(t.text()).toContain(`ends in ...${key.slice(-4)}`);
    expect(t.text()).not.toContain(key);
    expect(t.text()).not.toContain(key.slice(-12)); // not even a longer tail
    expect(t.asked.join()).not.toContain(key);
    if (process.platform !== 'win32') expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('keeps every other line and comment, and replaces an old key (also duplicates)', async () => {
    const oldKey = fakeApiKey();
    const newKey = fakeApiKey();
    fs.writeFileSync(
      envPath,
      `# my settings\nDATABASE_URL=file:./data/x.db\nANTHROPIC_API_KEY=${oldKey}\nTRADING_MODE=paper\nANTHROPIC_API_KEY=${oldKey}\n`,
    );
    const t = fakeIo([newKey]);
    expect(await setKeyFlow(t.io, { envPath, argv: [] })).toBe(0);
    const text = fs.readFileSync(envPath, 'utf8');
    expect(text).toBe(
      `# my settings\nDATABASE_URL=file:./data/x.db\nANTHROPIC_API_KEY=${newKey}\nTRADING_MODE=paper\n`,
    );
    expect(text).not.toContain(oldKey);
  });

  it('refuses any argument (the key must never be on the command line)', async () => {
    const key = fakeApiKey();
    const t = fakeIo([key]);
    expect(await setKeyFlow(t.io, { envPath, argv: [key] })).toBe(2);
    expect(fs.existsSync(envPath)).toBe(false);
    expect(t.text()).not.toContain(key);
    expect(t.asked).toEqual([]); // it did not even ask
  });

  it('refuses without a real terminal (the real prompt rejects when stdin is not a TTY)', async () => {
    expect(process.stdin.isTTY).toBeFalsy(); // true under the test runner
    await expect(readHiddenLine('x')).rejects.toBeInstanceOf(NotATerminalError);
    const t = fakeIo([new NotATerminalError()]);
    await expect(setKeyFlow(t.io, { envPath, argv: [] })).rejects.toBeInstanceOf(NotATerminalError);
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('rejects a wrong-shaped key without echoing it, lets you retry, and gives up after 3 tries', async () => {
    const bad = 'not-a-key-SUPERSECRETTYPO';
    const t = fakeIo([
      bad,
      'replace-with-your-key-from-the-anthropic-console-see-docs-analyst',
      '',
      bad,
    ]);
    expect(await setKeyFlow(t.io, { envPath, argv: [] })).toBe(1);
    expect(fs.existsSync(envPath)).toBe(false);
    expect(t.text()).not.toContain('SUPERSECRETTYPO');
    expect(t.text()).toContain('Too many attempts');
  });

  it('accepts a good key on the second try', async () => {
    const key = fakeApiKey();
    const t = fakeIo(['oops', `  ${key}  `]);
    expect(await setKeyFlow(t.io, { envPath, argv: [] })).toBe(0);
    expect(fs.readFileSync(envPath, 'utf8')).toBe(`ANTHROPIC_API_KEY=${key}\n`);
  });

  it('refuses to write where git could track the file', async () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    const key = fakeApiKey();
    const t = fakeIo([key]);
    expect(await setKeyFlow(t.io, { envPath, argv: [] })).toBe(1);
    expect(fs.existsSync(envPath)).toBe(false);
    expect(t.text()).toContain('.gitignore');
    fs.rmSync(path.join(dir, '.gitignore'));
    expect(envIsGitIgnored(envPath)).toBe(false);
  });

  it('keeps Windows line endings', () => {
    const k = fakeApiKey();
    expect(withKey('A=1\r\nANTHROPIC_API_KEY=old\r\n', k)).toBe(
      `A=1\r\nANTHROPIC_API_KEY=${k}\r\n`,
    );
  });

  it('the repository .gitignore really ignores .env (so the real script will run)', () => {
    expect(envIsGitIgnored(path.resolve(import.meta.dirname, '..', '..', '.env'))).toBe(true);
  });
});
