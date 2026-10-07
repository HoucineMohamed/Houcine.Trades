import { describe, expect, it } from 'vitest';
import { tradeTimeline, type TimelineInput } from './timeline';

const base: TimelineInput = {
  status: 'planned',
  createdAt: '2026-03-01T08:00:00.000Z',
  openedAt: null,
  closedAt: null,
  closedRecordedAt: null,
  updatedAt: '2026-03-01T08:00:00.000Z',
};
const keys = (t: TimelineInput) => tradeTimeline(t).map((s) => `${s.key}:${s.done}`);

describe('tradeTimeline', () => {
  it('planned: created is done, opening and closing are still ahead', () => {
    expect(keys(base)).toEqual(['created:true', 'opened:false', 'closed:false']);
    expect(tradeTimeline(base).map((s) => s.at)).toEqual([base.createdAt, null, null]);
  });
  it('open: opened has its time', () => {
    const t = { ...base, status: 'open' as const, openedAt: '2026-03-02T09:00:00.000Z' };
    expect(keys(t)).toEqual(['created:true', 'opened:true', 'closed:false']);
    expect(tradeTimeline(t)[1]?.at).toBe('2026-03-02T09:00:00.000Z');
  });
  it('closed: every step is done, and a backdated close says when it was recorded', () => {
    const t = {
      ...base,
      status: 'closed' as const,
      openedAt: '2026-03-02T09:00:00.000Z',
      closedAt: '2026-03-02T15:00:00.000Z',
      closedRecordedAt: '2026-03-05T10:00:00.000Z',
    };
    const steps = tradeTimeline(t);
    expect(steps.map((s) => s.done)).toEqual([true, true, true]);
    expect(steps[2]?.note).toContain('2026-03-05T10:00:00.000Z');
  });
  it('a close recorded at the same time has no note', () => {
    const t = {
      ...base,
      status: 'closed' as const,
      openedAt: '2026-03-02T09:00:00.000Z',
      closedAt: '2026-03-02T15:00:00.000Z',
      closedRecordedAt: '2026-03-02T15:00:00.000Z',
    };
    expect(tradeTimeline(t)[2]?.note).toBeNull();
  });
  it('cancelled: created then cancelled, nothing after', () => {
    const t = { ...base, status: 'cancelled' as const, updatedAt: '2026-03-03T00:00:00.000Z' };
    expect(keys(t)).toEqual(['created:true', 'cancelled:true']);
    expect(tradeTimeline(t)[1]?.at).toBe('2026-03-03T00:00:00.000Z');
  });
});
