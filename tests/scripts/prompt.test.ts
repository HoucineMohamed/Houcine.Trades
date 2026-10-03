import { describe, expect, it } from 'vitest';
import { applyKeys, type KeyState } from '../../scripts/auth/prompt';

const start: KeyState = { value: '', done: false, aborted: false };
const type = (text: string, from: KeyState = start) => applyKeys(from, text);

describe('hidden password input (key handling)', () => {
  it('collects characters and finishes on Enter', () => {
    expect(type('hello\r')).toEqual({ value: 'hello', done: true, aborted: false });
    expect(type('hello\n')).toEqual({ value: 'hello', done: true, aborted: false });
  });

  it('works key by key as well as for pasted text', () => {
    let s = start;
    for (const ch of 'abc') s = applyKeys(s, ch);
    expect(s.value).toBe('abc');
    expect(applyKeys(s, '\r').done).toBe(true);
  });

  it('Backspace removes the last character (also a whole emoji)', () => {
    expect(type('abc\u007f\u007f').value).toBe('a');
    expect(type('ab\b').value).toBe('a');
    expect(type('a\u{1F600}\u007f').value).toBe('a');
    expect(type('\u007f\u007f').value).toBe('');
  });

  it('Ctrl+C aborts and ignores everything after it', () => {
    expect(type('ab\u0003cd\r')).toEqual({ value: 'ab', done: false, aborted: true });
  });

  it('Ctrl+U clears the line', () => {
    expect(type('abc\u0015xy').value).toBe('xy');
  });

  it('ignores arrow keys and other escape sequences, and control characters', () => {
    expect(type('ab\u001b[Acd').value).toBe('ab');
    expect(type('a\u0001b\u0002').value).toBe('ab');
  });

  it('stops reading after Enter (nothing typed afterwards is added)', () => {
    expect(type('abc\rdef').value).toBe('abc');
  });

  it('keeps spaces and unicode in passwords', () => {
    expect(type('correct horse é\r').value).toBe('correct horse é');
  });
});
