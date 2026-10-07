import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotATerminalError } from '../../scripts/auth/prompt';
import {
  newPairingCode,
  setTelegramFlow,
  withEnvValue,
  type NotifyIo,
} from '../../scripts/notify/flows';
import { fakeBotToken, fakePairingSource, msg } from '../helpers/notifications';

const CODE = 'HT-7KQ2-M9XP';
const CHAT = 987_654_321;

function fakeIo(secrets: (string | Error)[], lines: string[]) {
  const out: string[] = [];
  const io: NotifyIo = {
    readSecret: async () => {
      const v = secrets.shift();
      if (v === undefined) throw new Error('unexpected token prompt');
      if (v instanceof Error) throw v;
      return v;
    },
    readLine: async () => lines.shift() ?? '',
    print: (line = '') => void out.push(line),
  };
  return { io, text: () => out.join('\n') };
}

let dir = '';
let envPath = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houcine-telegram-'));
  envPath = path.join(dir, '.env');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n.env.*\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A clock that moves forward by the length of each long poll, so a timeout test is instant. */
function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function run(
  batches: Parameters<typeof fakePairingSource>[0],
  o: {
    secrets?: (string | Error)[];
    lines?: string[];
    token?: string;
    totalMs?: number;
    argv?: string[];
    raw?: boolean;
  } = {},
) {
  const token = o.token ?? fakeBotToken();
  const t = fakeIo(o.secrets ?? [token], o.lines ?? ['YES']);
  // the first request is always the clean-up of old messages; an empty first batch means "none waiting"
  const source = fakePairingSource(o.raw ? batches : [[], ...batches]);
  const c = clock();
  const wrapped = {
    getUpdates: async (i: { offset: number | null; timeoutSec: number }) => {
      const r = await source.getUpdates(i);
      c.advance(Math.max(i.timeoutSec, 1) * 1000);
      return r;
    },
  };
  let logged = 0;
  const done = setTelegramFlow(t.io, {
    envPath,
    argv: o.argv ?? [],
    makeSource: () => wrapped,
    makeCode: () => CODE,
    now: c.now,
    totalMs: o.totalMs ?? 60_000,
    pollSec: 20,
    logChange: () => void (logged += 1),
  });
  return { token, t, source, done, logged: () => logged };
}
/** The stored chat id (the token line has random digits, so never search the whole file). */
const chatLine = () =>
  env()
    .split('\n')
    .find((l) => l.startsWith('TELEGRAM_CHAT_ID=')) ?? '';
const env = () => (fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '');

describe('npm run notify:set-telegram: the token', () => {
  it('writes the token, shows only its last 4 characters, never the token', async () => {
    const r = run([[msg(1, CHAT, CODE)]]);
    expect(await r.done).toBe(0);
    expect(env()).toContain(`TELEGRAM_BOT_TOKEN=${r.token}`);
    expect(r.t.text()).toContain(`ends in ...${r.token.slice(-4)}`);
    expect(r.t.text()).not.toContain(r.token);
    expect(r.t.text()).not.toContain(r.token.slice(-10));
  });
  it('refuses any argument (the token must never be on the command line) and does not even ask', async () => {
    const token = fakeBotToken();
    const r = run([], { argv: [token] });
    expect(await r.done).toBe(2);
    expect(env()).toBe('');
    expect(r.t.text()).not.toContain(token);
  });
  it('refuses without a real terminal', async () => {
    const t = fakeIo([new NotATerminalError()], []);
    await expect(
      setTelegramFlow(t.io, { envPath, argv: [], makeSource: () => fakePairingSource([]) }),
    ).rejects.toBeInstanceOf(NotATerminalError);
    expect(env()).toBe('');
  });
  it('refuses to write where git could track the file', async () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    const r = run([]);
    expect(await r.done).toBe(1);
    expect(env()).toBe('');
    expect(r.t.text()).toContain('.gitignore');
  });
  it('rejects a wrong-shaped token without echoing it, and gives up after 3 tries', async () => {
    const bad = '123456789:SUPERSECRETTYPO';
    const r = run([], {
      secrets: [bad, 'replace-with-your-bot-token-from-botfather-see-docs', ''],
    });
    expect(await r.done).toBe(1);
    expect(env()).toBe('');
    expect(r.t.text()).not.toContain('SUPERSECRETTYPO');
    expect(r.t.text()).toContain('Too many attempts');
  });
  it('keeps the other lines of .env, replaces an old token, and REMOVES an old chat id until pairing succeeds', async () => {
    fs.writeFileSync(
      envPath,
      '# mine\nDATABASE_URL=file:./x.db\nTELEGRAM_BOT_TOKEN=old\nTELEGRAM_CHAT_ID=111222333\nTRADING_MODE=paper\n',
    );
    const r = run([], { lines: ['NO'] });
    await r.done;
    const text = env();
    expect(text).toContain('# mine');
    expect(text).toContain('DATABASE_URL=file:./x.db');
    expect(text).toContain('TRADING_MODE=paper');
    expect(text).not.toContain('=old');
    expect(text).not.toContain('TELEGRAM_CHAT_ID');
  });
  it('withEnvValue: replaces, appends, removes, drops duplicates, keeps Windows line endings', () => {
    expect(withEnvValue(null, 'A', '1')).toBe('A=1\n');
    expect(withEnvValue('A=0\nB=2\nA=3\n', 'A', '1')).toBe('A=1\nB=2\n');
    expect(withEnvValue('A=0\nB=2\n', 'A', null)).toBe('B=2\n');
    expect(withEnvValue('B=2\r\n', 'A', '1')).toBe('B=2\r\nA=1\r\n');
    expect(withEnvValue('A=1\n', 'A', null)).toBe('');
  });
});

describe('pairing: only the exact code from a private chat, nothing else', () => {
  it('pairs on the code, confirms by the last digits only, and stores the chat id', async () => {
    const r = run([[msg(1, CHAT, CODE)]]);
    expect(await r.done).toBe(0);
    expect(env()).toContain(`TELEGRAM_CHAT_ID=${CHAT}`);
    expect(r.t.text()).toContain('ends in ...321');
    expect(r.t.text()).not.toContain(String(CHAT));
    expect(r.t.text()).toContain(CODE); // the one-time code IS shown (that is its purpose)
    expect(r.logged()).toBe(1);
  });
  it('accepts the deep-link form "/start <code>"', async () => {
    const r = run([[msg(1, CHAT, `/start ${CODE}`)]]);
    expect(await r.done).toBe(0);
  });
  it('IGNORES a wrong code, another sender, a group, a command and an empty message, then pairs on the right one', async () => {
    const r = run([
      [
        msg(1, 555, 'HT-AAAA-BBBB'),
        msg(2, 556, CODE, 'group'),
        msg(3, 557, CODE, 'supergroup'),
        msg(4, 558, '/halt'),
        msg(5, 559, '/start'),
        msg(6, 560, null),
      ],
      [msg(7, 561, `${CODE} please`), msg(8, 562, `please ${CODE}`), msg(9, -100123, CODE)],
      [msg(10, CHAT, CODE)],
    ]);
    expect(await r.done).toBe(0);
    expect(env()).toContain(`TELEGRAM_CHAT_ID=${CHAT}`);
    for (const wrong of ['555', '556', '557', '558', '559', '560', '561', '562', '100123'])
      expect(chatLine()).not.toContain(wrong);
  });
  it('a stale message that was waiting BEFORE pairing started can never pair (it is thrown away first)', async () => {
    const r = run([[msg(1, 777, CODE)], [], [msg(2, CHAT, CODE)]], { raw: true });
    expect(await r.done).toBe(0);
    expect(env()).toContain(`TELEGRAM_CHAT_ID=${CHAT}`);
    expect(chatLine()).not.toContain('777');
  });
  it('two DIFFERENT chats sending the code at once is refused (fail closed)', async () => {
    const r = run([[], [msg(1, 111_222_333, CODE), msg(2, 444_555_666, CODE)]]);
    expect(await r.done).toBe(1);
    expect(env()).not.toContain('TELEGRAM_CHAT_ID');
    expect(r.t.text()).toContain('nothing was paired');
  });
  it('times out when nobody sends the code, and pairs nothing', async () => {
    const r = run([[]], { totalMs: 45_000 });
    expect(await r.done).toBe(1);
    expect(r.t.text()).toContain('Timed out');
    expect(env()).not.toContain('TELEGRAM_CHAT_ID');
    expect(r.logged()).toBe(0);
  });
  it('the owner must type YES; anything else saves nothing', async () => {
    for (const answer of ['', 'yes', 'y', 'NO']) {
      const r = run([[msg(1, CHAT, CODE)]], { lines: [answer] });
      expect(await r.done, answer).toBe(1);
      expect(env()).not.toContain('TELEGRAM_CHAT_ID');
      fs.rmSync(envPath, { force: true });
    }
  });
  it('confirms the accepted message with Telegram so it is not delivered again', async () => {
    const r = run([[], [msg(41, CHAT, CODE)]]);
    await r.done;
    const offsets = r.source.requests.map((q) => q.offset);
    expect(offsets[offsets.length - 1]).toBe(42);
  });
  it('a chat id that is not a private chat number is refused even if it carried the code', async () => {
    const r = run([[msg(1, -123456, CODE, 'private')]]); // negative: never accepted as a code sender
    const done = await Promise.race([
      r.done,
      new Promise<number>((res) => setTimeout(() => res(-1), 3000)),
    ]);
    expect(done).not.toBe(0);
    expect(env()).not.toContain('TELEGRAM_CHAT_ID');
  });
  it('no command is ever executed: the script only ever writes the token and the chat id', async () => {
    const r = run([[msg(1, 5, '/halt'), msg(2, 5, '/reset RESET'), msg(3, CHAT, CODE)]]);
    await r.done;
    expect(
      env()
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('=')[0])
        .sort(),
    ).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  });
});

describe('pairing: an unverified reply stops everything', () => {
  it.each([
    ['bad_response', 'could not be verified'],
    ['unauthorized', 'did not accept the token'],
    ['conflict', 'webhook'],
    ['network', 'could not be reached'],
  ] as const)('%s', async (code, words) => {
    const r = run([{ code }]);
    expect(await r.done).toBe(1);
    expect(r.t.text()).toContain(words);
    expect(env()).not.toContain('TELEGRAM_CHAT_ID');
  });
  it('a bad reply in the middle of waiting also stops it', async () => {
    const r = run([[], { code: 'bad_response' }]);
    expect(await r.done).toBe(1);
    expect(env()).not.toContain('TELEGRAM_CHAT_ID');
  });
});

describe('the one-time code', () => {
  it('is random, readable, and has no ambiguous characters', () => {
    const codes = new Set(Array.from({ length: 50 }, newPairingCode));
    expect(codes.size).toBeGreaterThan(40);
    for (const c of codes) expect(c).toMatch(/^HT-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });
});
