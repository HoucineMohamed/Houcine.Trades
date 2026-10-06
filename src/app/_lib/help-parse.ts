/**
 * A tiny Markdown reader for the plain-language docs (docs/stats-glossary.md, docs/risk-rules.md).
 * The docs are the ONLY source of the "What does this mean?" texts: this code finds a heading (or
 * a table row) and returns its text, so the explanations on screen cannot drift from the docs.
 * Pure: no files here.
 */

export interface Section {
  level: number;
  title: string;
  /** The lines under the heading, up to the next heading of any level. */
  lines: string[];
}

export function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      current = { level: (heading[1] as string).length, title: heading[2] as string, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

export type Block = { type: 'paragraph'; text: string } | { type: 'list'; items: string[] };

/** Paragraphs and bullet lists. Tables, code blocks and raw HTML are left out. */
export function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  let inFence = false;
  const flush = () => {
    if (para.length > 0) blocks.push({ type: 'paragraph', text: para.join(' ').trim() });
    if (list) blocks.push({ type: 'list', items: list });
    para = [];
    list = null;
  };
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flush();
    } else if (/^\s*\|/.test(line) || /^\s*</.test(line)) {
      flush(); // table row or HTML
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (para.length > 0) {
        blocks.push({ type: 'paragraph', text: para.join(' ').trim() });
        para = [];
      }
      list ??= [];
      list.push(line.replace(/^\s*[-*]\s+/, '').trim());
    } else if (list && /^\s{2,}\S/.test(line)) {
      list[list.length - 1] += ` ${line.trim()}`; // a wrapped list item
    } else {
      if (list) flush();
      para.push(line.replace(/^>\s?/, '').trim());
    }
  }
  flush();
  return blocks.filter((b) => (b.type === 'paragraph' ? b.text !== '' : b.items.length > 0));
}

/** Splits one table row into cells (an escaped pipe stays inside its cell). */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c === '\\' && body[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (c === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

export interface TableRow {
  /** First cell without bold marks and without a trailing "(CODE)". */
  key: string;
  cells: string[];
}

export function parseTableRows(lines: readonly string[]): TableRow[] {
  const rows: TableRow[] = [];
  for (const line of lines) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // the --- separator row
    const key = (cells[0] ?? '')
      .replace(/\*\*/g, '')
      .replace(/\s*\(.*\)\s*$/, '')
      .trim();
    rows.push({ key, cells });
  }
  return rows;
}

// ---- inline text: `code`, **bold**, _italic_, [links](only the text is kept) -------------------

export type Token =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string };

export function inlineTokens(text: string): Token[] {
  const clean = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const tokens: Token[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w])_([^_]+)_(?![\w])/g;
  let last = 0;
  for (const m of clean.matchAll(pattern)) {
    if (m.index > last) tokens.push({ type: 'text', text: clean.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ type: 'code', text: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: 'strong', text: m[2] });
    else tokens.push({ type: 'em', text: m[3] as string });
    last = m.index + m[0].length;
  }
  if (last < clean.length) tokens.push({ type: 'text', text: clean.slice(last) });
  return tokens;
}

/** Plain text of a block (for tests and for checking the wording). */
export function blockText(block: Block): string {
  const raw = block.type === 'paragraph' ? block.text : block.items.join(' ');
  return inlineTokens(raw)
    .map((t) => t.text)
    .join('');
}
