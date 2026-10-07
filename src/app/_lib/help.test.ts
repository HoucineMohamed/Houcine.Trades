import { describe, expect, it } from 'vitest';
import { allHelp, HELP, resolveHelp } from './help';
import { blockText, inlineTokens, parseBlocks, parseSections, parseTableRows } from './help-parse';

const DOC = `# Title

Intro.

## First

Para one
continues here.

- item one
  wrapped
- item two

\`\`\`
code is skipped
\`\`\`

| Rule | Meaning | Why |
| ---- | ------- | --- |
| **Max thing** (\`CODE\`) | It means \\| a pipe. | Because. |

### Sub

Sub text.
`;

describe('parseSections', () => {
  it('finds headings with their level and the lines up to the next heading', () => {
    const s = parseSections(DOC);
    expect(s.map((x) => [x.level, x.title])).toEqual([
      [1, 'Title'],
      [2, 'First'],
      [3, 'Sub'],
    ]);
    expect(s[2]?.lines.join('\n')).toContain('Sub text.');
  });
  it('ignores "#" lines inside code fences', () => {
    const s = parseSections('## A\n```\n# not a heading\n```\ntext');
    expect(s.map((x) => x.title)).toEqual(['A']);
  });
});

describe('parseBlocks', () => {
  it('joins wrapped paragraph lines, reads lists, skips code fences and tables', () => {
    const first = parseSections(DOC)[1]!;
    expect(parseBlocks(first.lines)).toEqual([
      { type: 'paragraph', text: 'Para one continues here.' },
      { type: 'list', items: ['item one wrapped', 'item two'] },
    ]);
  });
  it('returns nothing for an empty section', () => {
    expect(parseBlocks(['', '  '])).toEqual([]);
  });
});

describe('parseTableRows', () => {
  it('reads rows, strips bold and the (CODE), handles escaped pipes, skips the separator', () => {
    const rows = parseTableRows(parseSections(DOC)[1]!.lines);
    expect(rows.map((r) => r.key)).toEqual(['Rule', 'Max thing']);
    expect(rows[1]?.cells[1]).toBe('It means | a pipe.');
  });
});

describe('inlineTokens', () => {
  it('reads code, bold, italic and keeps only the text of links', () => {
    expect(inlineTokens('a `b` **c** _d_ [e](http://x.test) f')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: 'b' },
      { type: 'text', text: ' ' },
      { type: 'strong', text: 'c' },
      { type: 'text', text: ' ' },
      { type: 'em', text: 'd' },
      { type: 'text', text: ' e f' },
    ]);
  });
  it('does not treat snake_case as italic', () => {
    expect(inlineTokens('use my_var_name here')).toEqual([
      { type: 'text', text: 'use my_var_name here' },
    ]);
  });
  it('never leaves a URL behind', () => {
    const text = blockText({ type: 'paragraph', text: 'see [the page](https://example.com/x)' });
    expect(text).toBe('see the page');
  });
});

describe('resolveHelp', () => {
  it('returns a table row as two paragraphs, and null for unknown headings or rows', () => {
    expect(resolveHelp({ file: 'risk-rules', heading: 'First', row: 'Max thing' }, DOC)).toEqual([
      { type: 'paragraph', text: 'It means | a pipe.' },
      { type: 'paragraph', text: 'Why it exists: Because.' },
    ]);
    expect(resolveHelp({ file: 'risk-rules', heading: 'Nope' }, DOC)).toBeNull();
    expect(resolveHelp({ file: 'risk-rules', heading: 'First', row: 'Nope' }, DOC)).toBeNull();
  });
});

// ---- the real docs -----------------------------------------------------------------------------

const ADVICE = /\b(good|bad|great|poor|best|worst|should|ought|recommend\w*|be honest|you must)\b/i;

describe('the real docs are the single source of the help texts', () => {
  const all = allHelp();

  it('every key resolves to non-empty text from docs/', () => {
    const missing = all.filter((h) => h.blocks === null).map((h) => h.key);
    expect(missing).toEqual([]);
    expect(all.length).toBe(Object.keys(HELP).length);
  });

  it('no help text uses advice or judging wording', () => {
    const offenders: string[] = [];
    for (const { key, blocks } of all) {
      for (const b of blocks ?? []) {
        const text = blockText(b);
        const m = ADVICE.exec(text);
        if (m) offenders.push(`${key}: "${m[0]}" in "${text.slice(0, 80)}..."`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no help text contains a link or an address', () => {
    for (const { key, blocks } of all) {
      for (const b of blocks ?? []) {
        expect(blockText(b), key).not.toMatch(/https?:\/\/|www\./i);
      }
    }
  });
});
