import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the review agents in .claude/agents/ (see CLAUDE.md, "Review workflow"):
 * - every agent file keeps the "CLAUDE.md overrides this agent" line,
 * - no .claude/settings.json or settings.local.json defines hooks,
 * - no agent file tells Claude to delete lockfiles, skip/quarantine tests or push to a remote.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');
const AGENTS = [
  'code-reviewer',
  'typescript-reviewer',
  'security-reviewer',
  'silent-failure-hunter',
  'tdd-guide',
];
const OVERRIDE_LINE = 'Houcine.Trades CLAUDE.md overrides this agent.';

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  {
    name: 'deleting lockfiles',
    pattern:
      /\b(rm|del|delete|remove|unlink)\b[^\n]{0,60}(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|lock ?file)/i,
  },
  {
    name: 'skipping or quarantining tests',
    pattern:
      /\b(quarantin\w*|disabl\w*|skip\w*|comment(?:ing)? out|delet\w*)\b[^\n.]{0,30}\b(failing |flaky )?tests?\b|\b(it|test|describe)\.(skip|only|todo)\(|\bx(it|describe)\(|--no-verify/i,
  },
  { name: 'pushing to a remote', pattern: /\bgit\s+push\b|\bgit\s+remote\s+(add|set-url)\b/i },
];

export function problemsInAgentText(file: string, text: string): string[] {
  const problems: string[] = [];
  if (!text.includes(OVERRIDE_LINE)) problems.push(`${file}: missing the CLAUDE.md-override line`);
  for (const rule of FORBIDDEN) {
    const line = text.split('\n').findIndex((l) => rule.pattern.test(l));
    if (line >= 0) problems.push(`${file}:${line + 1}: instruction involving ${rule.name}`);
  }
  return problems;
}

/** Returns a problem text if the settings JSON defines hooks (or cannot be read as JSON). */
export function hooksProblem(file: string, json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return `${file}: is not valid JSON, so it cannot be checked for hooks`;
  }
  return parsed !== null && typeof parsed === 'object' && 'hooks' in parsed
    ? `${file}: defines hooks (needs the owner's explicit approval)`
    : null;
}

describe('review agents', () => {
  it('has exactly the five vetted agent files (plus the README)', () => {
    expect(fs.readdirSync(AGENTS_DIR).sort()).toEqual(
      ['README.md', ...AGENTS.map((a) => `${a}.md`)].sort(),
    );
  });

  for (const agent of AGENTS) {
    it(`${agent}: keeps the override line and has no forbidden instruction`, () => {
      const text = fs.readFileSync(path.join(AGENTS_DIR, `${agent}.md`), 'utf8');
      expect(problemsInAgentText(`${agent}.md`, text)).toEqual([]);
    });
  }

  it('the README keeps the MIT license and attribution', () => {
    const text = fs.readFileSync(path.join(AGENTS_DIR, 'README.md'), 'utf8');
    expect(text).toContain('MIT License');
    expect(text).toContain('Copyright (c) 2026 Affaan Mustafa');
    expect(text).toContain('everything-claude-code');
  });
});

describe('no hooks in Claude settings files', () => {
  for (const name of ['settings.json', 'settings.local.json']) {
    it(`.claude/${name} does not define hooks`, () => {
      const file = path.join(ROOT, '.claude', name);
      if (!fs.existsSync(file)) return; // absent is fine
      expect(hooksProblem(`.claude/${name}`, fs.readFileSync(file, 'utf8'))).toBeNull();
    });
  }
});

describe('the checks themselves catch problems (so a pass means something)', () => {
  const ok = `> ${OVERRIDE_LINE}\n\nReview the diff and report findings.\n`;
  it('accepts a clean agent text', () => {
    expect(problemsInAgentText('x.md', ok)).toEqual([]);
  });
  it('flags a missing override line', () => {
    expect(problemsInAgentText('x.md', 'Review the diff.\n')).not.toEqual([]);
  });
  it.each([
    'If the build fails, rm -rf node_modules and delete package-lock.json',
    'Remove the lockfile and reinstall',
    'Quarantine flaky tests so the run goes green',
    'Skip failing tests when in a hurry',
    'Disable the test that keeps failing',
    "Use it.skip('later', () => {})",
    'git commit --no-verify',
    'Then run git push origin main',
    'git remote add evil https://example.com/x.git',
  ])('flags: %s', (line) => {
    expect(problemsInAgentText('x.md', `${ok}${line}\n`)).not.toEqual([]);
  });
  it('flags hooks in a settings file, and unreadable settings', () => {
    expect(hooksProblem('s.json', '{"hooks":{"PreToolUse":[]}}')).not.toBeNull();
    expect(hooksProblem('s.json', '{"hooks":{}}')).not.toBeNull();
    expect(hooksProblem('s.json', '{not json')).not.toBeNull();
    expect(hooksProblem('s.json', '{"permissions":{"allow":[]}}')).toBeNull();
  });
});
