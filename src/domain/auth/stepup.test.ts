import { describe, expect, it } from 'vitest';
import {
  assertFreshAuth,
  isStepUpFresh,
  issueFreshAuth,
  STEP_UP_WINDOW_MS,
  StepUpRequiredError,
} from './stepup';

const T0 = new Date('2026-03-10T12:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

describe('step-up freshness (a code entered within the last 5 minutes)', () => {
  it('fresh strictly inside 5 minutes; stale exactly at 5 minutes', () => {
    expect(STEP_UP_WINDOW_MS).toBe(300_000);
    expect(isStepUpFresh(T0.toISOString(), plus(0))).toBe(true);
    expect(isStepUpFresh(T0.toISOString(), plus(299_999))).toBe(true);
    expect(isStepUpFresh(T0.toISOString(), plus(300_000))).toBe(false);
  });

  it('never fresh when missing, unreadable, or in the future', () => {
    expect(isStepUpFresh(null, T0)).toBe(false);
    expect(isStepUpFresh(undefined, T0)).toBe(false);
    expect(isStepUpFresh('nonsense', T0)).toBe(false);
    expect(isStepUpFresh(plus(10_000).toISOString(), T0)).toBe(false);
  });
});

describe('the FreshAuth proof', () => {
  it('a genuine proof passes while fresh and is returned', () => {
    const proof = issueFreshAuth(7, T0);
    expect(assertFreshAuth(proof, plus(1000), 'x')).toBe(proof);
    expect(proof.sessionId).toBe(7);
    expect(Object.isFrozen(proof)).toBe(true);
  });

  it('a proof older than 5 minutes is refused', () => {
    const proof = issueFreshAuth(7, T0);
    expect(() => assertFreshAuth(proof, plus(299_999), 'x')).not.toThrow();
    expect(() => assertFreshAuth(proof, plus(300_000), 'x')).toThrow(StepUpRequiredError);
  });

  it('missing or forged proofs are refused (a look-alike object is not enough)', () => {
    expect(() => assertFreshAuth(null, T0, 'reset a halt')).toThrow(StepUpRequiredError);
    expect(() => assertFreshAuth(undefined, T0, 'x')).toThrow(StepUpRequiredError);
    const forged = { sessionId: 1, verifiedAt: T0.toISOString() } as never;
    expect(() => assertFreshAuth(forged, T0, 'x')).toThrow(StepUpRequiredError);
    expect(() => assertFreshAuth('yes' as never, T0, 'x')).toThrow(StepUpRequiredError);
    // a copy of a genuine proof is also not genuine
    expect(() => assertFreshAuth({ ...issueFreshAuth(1, T0) } as never, T0, 'x')).toThrow(
      StepUpRequiredError,
    );
  });

  it('the error says what needed the code', () => {
    try {
      assertFreshAuth(null, T0, 'resetting a halt');
    } catch (e) {
      expect((e as StepUpRequiredError).reason).toBe('resetting a halt');
      expect((e as Error).message).toContain('resetting a halt');
    }
  });
});
