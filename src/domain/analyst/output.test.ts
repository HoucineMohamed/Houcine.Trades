import { describe, expect, it } from 'vitest';
import {
  checkOutput,
  findInstructionWording,
  parseAnalystOutput,
  verifyFigures,
  type PlanReviewOutput,
} from './output';

const plan = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    explanation: 'The plan risks 1.5 percent.',
    questions: ['Why this stop?'],
    conflicts: [],
    cited_figures: [{ label: 'risk percent', value: '1.5' }],
    ...over,
  });

describe('parseAnalystOutput', () => {
  it('accepts a valid plan review', () => {
    const r = parseAnalystOutput('plan_review', plan());
    expect(r.ok).toBe(true);
  });
  it('accepts valid weekly and tutor shapes', () => {
    expect(
      parseAnalystOutput(
        'weekly_review',
        JSON.stringify({
          summary: 's',
          patterns: [],
          mistakes: [],
          rule_breaking: [],
          data_limits: [],
          questions: [],
          cited_figures: [],
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseAnalystOutput(
        'tutor',
        JSON.stringify({ explanation: 'e', example: 'x', key_points: [], cited_figures: [] }),
      ).ok,
    ).toBe(true);
  });
  it('rejects text that is not JSON, wrong shapes, extra fields and wrong kinds', () => {
    expect(parseAnalystOutput('plan_review', 'Sure! Here you go').ok).toBe(false);
    expect(parseAnalystOutput('plan_review', '```json\n{}\n```').ok).toBe(false);
    expect(parseAnalystOutput('plan_review', plan({ extra: 'x' })).ok).toBe(false);
    expect(parseAnalystOutput('plan_review', plan({ questions: 'not a list' })).ok).toBe(false);
    expect(parseAnalystOutput('plan_review', '{}').ok).toBe(false);
    expect(parseAnalystOutput('tutor', plan()).ok).toBe(false);
    expect(parseAnalystOutput('plan_review', plan({ explanation: 'x'.repeat(3001) })).ok).toBe(
      false,
    );
  });
  it('never echoes the reply text in the problem message', () => {
    const r = parseAnalystOutput('plan_review', plan({ explanation: 5, secret: 'TOPSECRETVALUE' }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('TOPSECRETVALUE');
  });
  it('removes control characters but keeps HTML-looking text as plain text (it is escaped when shown)', () => {
    const r = parseAnalystOutput(
      'plan_review',
      plan({ explanation: 'a\u0000b <img src=x onerror=alert(1)>' }),
    );
    expect(r.ok && (r.output as PlanReviewOutput).explanation).toBe(
      'ab <img src=x onerror=alert(1)>',
    );
  });
});

describe('verifyFigures', () => {
  const allowed = ['1.5', '100', '-0.2500'];
  it('verifies exact text matches only', () => {
    const r = verifyFigures(
      [
        { label: 'a', value: '1.5' },
        { label: 'b', value: '1.50' }, // same number, different text: NOT verified
        { label: 'c', value: '-0.2500' },
        { label: 'd', value: '2' },
        { label: 'e', value: ' 100' },
      ],
      allowed,
    );
    expect(r.verified.map((f) => f.label)).toEqual(['a', 'c']);
    expect(r.unverified.map((f) => f.label)).toEqual(['b', 'd', 'e']);
  });
});

describe('findInstructionWording', () => {
  it.each([
    'You should close the trade now.',
    'I recommend buying more here.',
    'Consider selling half of the position.',
    'Increase your position size next time.',
    'Ignore the limit this once.',
    'Bypass the verdict and enter anyway.',
    'It is time to exit.',
    'Move your stop closer.',
    'You could also size up when confident.',
    'Override the halt if you feel good.',
  ])('flags: %s', (sentence) => {
    expect(findInstructionWording([sentence]).length).toBeGreaterThan(0);
  });

  it.each([
    'Take profits now.',
    'Buy.',
    'Raise the limit.',
    'You might want to take profit.',
    'Please exit.',
    'Reduce risk next week.',
  ])('flags (formerly missed): %s', (sentence) => {
    expect(findInstructionWording([sentence]).length).toBeGreaterThan(0);
  });

  it.each([
    'The risk engine refused the plan because the risk is above the limit.',
    'The stop-loss sits 5 below the entry, so the loss at the stop is 10.',
    'Expectancy is the average result per trade.',
    'The sample is small, so the figures may change a lot.',
    'What made you pick this entry?',
    'Two trades were logged by override of a refusal.',
    'Why did you add to the position?',
    'What made you close the trade early?',
    'You closed early on 3 trades.',
    'The stop was moved on trade 4.',
    'Exit rules were followed.',
    'Selling pressure was high that week.',
    'The trader moved the stop to breakeven.',
    'Consider the risk numbers above.',
  ])('does not flag a description or a plain question: %s', (sentence) => {
    expect(findInstructionWording([sentence])).toEqual([]);
  });
});

describe('known limits of the wording check (documented, pinned)', () => {
  it('a sentence that merely QUOTES an action can still be flagged (it only warns, the text stays)', () => {
    expect(findInstructionWording(['The notes mention wanting to buy more.']).length).toBe(1);
  });
});

describe('checkOutput', () => {
  const out = (over: Record<string, unknown> = {}) => {
    const r = parseAnalystOutput('plan_review', plan(over));
    if (!r.ok) throw new Error(r.problem);
    return r.output;
  };
  it('is clean when figures match and no instruction wording is found', () => {
    const c = checkOutput(out(), ['1.5']);
    expect(c.flagged).toBe(false);
    expect(c.figures.verified).toHaveLength(1);
  });
  it('flags an unmatched figure', () => {
    const c = checkOutput(out({ cited_figures: [{ label: 'x', value: '9.9' }] }), ['1.5']);
    expect(c.flagged).toBe(true);
    expect(c.figures.unverified).toHaveLength(1);
  });
  it('flags instruction wording and keeps the text', () => {
    const o = out({ explanation: 'You should close the trade.' });
    const c = checkOutput(o, ['1.5']);
    expect(c.flagged).toBe(true);
    expect(c.instructionHits).toHaveLength(1);
    expect((o as PlanReviewOutput).explanation).toBe('You should close the trade.');
  });
});
