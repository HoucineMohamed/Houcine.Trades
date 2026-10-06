import { describe, expect, it } from 'vitest';
import { ctx } from '@/domain/risk/fixtures';
import { riskStatus } from './status';

describe('riskStatus', () => {
  it('no halt, verified: says so in plain words', () => {
    expect(riskStatus(ctx())).toMatchObject({ tone: 'clear', label: 'No halt active' });
  });
  it('lists every active halt', () => {
    const halt = (kind: 'manual' | 'drawdown' | 'daily_loss') => ({
      kind,
      message: 'm',
      since: null,
      clearsAt: null,
      resetAllowedNow: false,
      resetAvailableAt: null,
      resetRemainingMs: null,
    });
    const s = riskStatus(ctx({ halts: [halt('manual'), halt('daily_loss')] }));
    expect(s.tone).toBe('halted');
    expect(s.label).toBe('HALTED: manual halt, daily-loss halt');
  });
  it('fails closed in words: unverifiable equity or settings are shown, never "clear"', () => {
    expect(riskStatus(ctx({ equity: null, equityProblem: 'Equity is zero.' }))).toMatchObject({
      tone: 'unverified',
      detail: expect.stringContaining('Equity is zero.'),
    });
    expect(riskStatus(ctx({ settings: null, settingsProblem: 'corrupt' })).tone).toBe('unverified');
  });
  it('a halt wins over an unverifiable state', () => {
    const s = riskStatus(
      ctx({
        equity: null,
        equityProblem: 'x',
        halts: [
          {
            kind: 'manual',
            message: 'm',
            since: null,
            clearsAt: null,
            resetAllowedNow: true,
            resetAvailableAt: null,
            resetRemainingMs: null,
          },
        ],
      }),
    );
    expect(s.tone).toBe('halted');
  });
});
