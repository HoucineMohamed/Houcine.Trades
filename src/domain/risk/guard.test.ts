import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors';
import { evaluatePlan } from './evaluate';
import { ctx, plan } from './fixtures';
import {
  ExecutionRefusedError,
  requireApprovedForExecution,
  validateHaltReason,
  validateOverride,
  validateReset,
} from './guard';

describe('execution guard: a refused plan can never become an order', () => {
  const approved = evaluatePlan(plan(), ctx());
  const refused = evaluatePlan(plan({ stop: null }), ctx());

  it('an approved verdict passes', () => {
    expect(() => requireApprovedForExecution(approved)).not.toThrow();
  });

  it('a refused verdict throws and names the codes', () => {
    expect(() => requireApprovedForExecution(refused)).toThrow(ExecutionRefusedError);
    try {
      requireApprovedForExecution(refused);
    } catch (e) {
      expect((e as ExecutionRefusedError).codes).toEqual(['NO_STOP_LOSS']);
    }
  });

  it('a missing verdict throws (never approve by default)', () => {
    expect(() => requireApprovedForExecution(null)).toThrow(ExecutionRefusedError);
    expect(() => requireApprovedForExecution(undefined)).toThrow(ExecutionRefusedError);
  });

  it('a tampered verdict (approved=true but with violations) throws', () => {
    expect(() => requireApprovedForExecution({ ...refused, approved: true })).toThrow(
      ExecutionRefusedError,
    );
  });

  it('there is NO override: it takes one argument, and extra arguments change nothing', () => {
    expect(requireApprovedForExecution.length).toBe(1);
    const sneaky = requireApprovedForExecution as unknown as (v: unknown, o?: unknown) => void;
    expect(() => sneaky(refused, { override: true, reason: 'please' })).toThrow(
      ExecutionRefusedError,
    );
  });
});

describe('typed confirmations', () => {
  it('override needs the exact word OVERRIDE and a reason of at least 10 characters', () => {
    expect(
      validateOverride({ confirm: 'OVERRIDE', reason: '  I already took this trade  ' }),
    ).toEqual({ reason: 'I already took this trade' });
    for (const confirm of ['override', 'Override', 'OVERRIDE ', '', null, undefined]) {
      expect(() => validateOverride({ confirm, reason: 'a good long reason' })).toThrow(
        ValidationError,
      );
    }
    for (const reason of ['', '   ', 'short', '123456789', null, undefined]) {
      expect(() => validateOverride({ confirm: 'OVERRIDE', reason })).toThrow(/at least 10/);
    }
    expect(() => validateOverride({ confirm: 'OVERRIDE', reason: '1234567890' })).not.toThrow(); // exactly 10
    expect(() => validateOverride({ confirm: 'OVERRIDE', reason: 'x'.repeat(501) })).toThrow(
      /at most 500/,
    );
  });

  it('reports both problems together', () => {
    try {
      validateOverride({ confirm: 'no', reason: 'x' });
    } catch (e) {
      expect((e as ValidationError).issues.map((i) => i.field).sort()).toEqual([
        'confirm',
        'reason',
      ]);
    }
  });

  it('reset needs the exact word RESET and a reason', () => {
    expect(validateReset({ confirm: 'RESET', reason: 'rested and reviewed' })).toEqual({
      reason: 'rested and reviewed',
    });
    expect(() => validateReset({ confirm: 'OVERRIDE', reason: 'rested and reviewed' })).toThrow(
      ValidationError,
    );
    expect(() => validateReset({ confirm: 'reset', reason: 'rested and reviewed' })).toThrow(
      ValidationError,
    );
  });

  it('a manual halt needs a short reason', () => {
    expect(validateHaltReason('  tired ')).toBe('tired');
    expect(() => validateHaltReason('ab')).toThrow(ValidationError);
    expect(() => validateHaltReason('')).toThrow(ValidationError);
    expect(() => validateHaltReason(null)).toThrow(ValidationError);
  });
});
