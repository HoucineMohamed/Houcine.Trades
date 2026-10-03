import { describe, expect, it } from 'vitest';
import { checkPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './policy';

describe('password policy', () => {
  it('requires at least 12 characters (11 fails, 12 can pass)', () => {
    expect(checkPassword('mV7#kQ9!xT2').ok).toBe(false); // 11 characters, otherwise strong
    expect(checkPassword('mV7#kQ9!xT2$').ok).toBe(true); // 12 characters
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it('rejects very long passwords (so nobody can make the server hash a huge input)', () => {
    expect(checkPassword('a1!Zq'.repeat(40)).ok).toBe(false);
    expect(checkPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)).problems.join(' ')).toMatch(
      /at most 128/,
    );
  });

  it.each([
    'password1234',
    'passwordpassword',
    'qwertyuiop12',
    'iloveyou12345',
    '123456789012',
    'aaaaaaaaaaaa',
    'abcdefghijkl',
    'letmein123456',
    'Password123456!',
    'qazwsxedcrfv',
  ])('rejects the common or patterned password %j', (pw) => {
    const r = checkPassword(pw);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/too easy to guess/);
  });

  it('rejects passwords containing the owner name or the app name, in any case', () => {
    for (const pw of ['Houcine-Is-Cool-4711!', 'MyTRADESjournal#9X7q', 'xK9#houcineP2$mq']) {
      const r = checkPassword(pw);
      expect(r.ok, pw).toBe(false);
      expect(r.problems.join(' ')).toMatch(/name of this app/);
    }
  });

  it('accepts a long random password and a passphrase of unrelated words', () => {
    expect(checkPassword('mV7#kQ9!xT2$pL5@wZ8%').ok).toBe(true);
    expect(checkPassword('lantern violin concrete orbit pepper').ok).toBe(true);
  });

  it('never repeats the password in its messages', () => {
    const pw = 'sup3rS3cretPlaceholder';
    const r = checkPassword(pw + pw.slice(0, 0), ['placeholder']);
    for (const p of r.problems) expect(p).not.toContain(pw);
  });

  it('copes with empty and non-string input without throwing', () => {
    expect(checkPassword('').ok).toBe(false);
    expect(checkPassword(undefined as unknown as string).ok).toBe(false);
  });

  it('extra words (such as an email name) can be forbidden too', () => {
    expect(checkPassword('mV7#kQ9!xT2$houcinemohamed', ['houcinemohamed']).ok).toBe(false);
  });
});
