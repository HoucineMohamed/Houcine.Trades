import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAnalystEnv } from '@/integrations/anthropic/env';
import { DEFAULT_ANALYST_MODEL, isPricedModel } from '@/domain/analyst';
import { fakeApiKey } from '../helpers/analyst';

describe('ANTHROPIC_API_KEY (validated lazily, like AUTH_SECRET)', () => {
  it('is ready with a well-formed key and the default model', () => {
    const key = fakeApiKey();
    const e = parseAnalystEnv({ ANTHROPIC_API_KEY: key });
    expect(e).toEqual({ status: 'ready', apiKey: key, model: DEFAULT_ANALYST_MODEL });
  });

  it('a missing or blank key means "off", not an error', () => {
    expect(parseAnalystEnv({}).status).toBe('no_key');
    expect(parseAnalystEnv({ ANTHROPIC_API_KEY: '   ' }).status).toBe('no_key');
  });

  it('rejects the placeholder, short keys, wrong prefixes and odd characters', () => {
    for (const bad of [
      'replace-with-your-key-from-the-anthropic-console-see-docs-analyst',
      'sk-ant-short',
      'x'.repeat(60),
      'sk-ant-' + 'a'.repeat(20) + ' ' + 'b'.repeat(20),
      'sk-ant-your-key-goes-here-' + 'a'.repeat(30),
    ]) {
      expect(parseAnalystEnv({ ANTHROPIC_API_KEY: bad }).status, bad).toBe('invalid');
    }
  });

  it('never echoes the value in a message', () => {
    for (const bad of ['sk-ant-SUPERSECRETVALUE-too-short', 'zz' + 'SUPERSECRETVALUE'.repeat(5)]) {
      const e = parseAnalystEnv({ ANTHROPIC_API_KEY: bad });
      expect(JSON.stringify(e)).not.toContain('SUPERSECRETVALUE');
    }
  });
});

describe('ANALYST_MODEL must be in the price table', () => {
  it('the built-in default is priced', () => {
    expect(isPricedModel(DEFAULT_ANALYST_MODEL)).toBe(true);
  });

  it('the value shown in .env.example is priced (this fails if you edit it to an unpriced model)', () => {
    const text = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', '..', '.env.example'),
      'utf8',
    );
    const line = text.split('\n').find((l) => /^ANALYST_MODEL=/.test(l));
    expect(line, 'ANALYST_MODEL must be listed in .env.example').toBeDefined();
    const value = (line as string).split('=')[1]?.trim() ?? '';
    expect(isPricedModel(value), `"${value}" is not in src/domain/analyst/pricing.ts`).toBe(true);
  });

  it('a model setting that is not priced turns the analyst off (and the message names the setting, not the value)', () => {
    const e = parseAnalystEnv({
      ANTHROPIC_API_KEY: fakeApiKey(),
      ANALYST_MODEL: 'some-future-model-9',
    });
    expect(e.status).toBe('invalid');
    expect(JSON.stringify(e)).toContain('ANALYST_MODEL');
    expect(JSON.stringify(e)).not.toContain('some-future-model-9');
  });

  it('uses a priced model when one is set', () => {
    const e = parseAnalystEnv({
      ANTHROPIC_API_KEY: fakeApiKey(),
      ANALYST_MODEL: 'claude-haiku-4-5',
    });
    expect(e).toMatchObject({ status: 'ready', model: 'claude-haiku-4-5' });
  });

  it('a blank model setting falls back to the default', () => {
    const e = parseAnalystEnv({ ANTHROPIC_API_KEY: fakeApiKey(), ANALYST_MODEL: '' });
    expect(e).toMatchObject({ status: 'ready', model: DEFAULT_ANALYST_MODEL });
  });
});
