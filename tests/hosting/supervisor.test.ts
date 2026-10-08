import { describe, expect, it } from 'vitest';
import { createLogger } from '@/hosting/logger';
import {
  Supervisor,
  type ChildProcessLike,
  type ChildSpec,
  type SupervisorOptions,
} from '@/hosting/supervisor';

class FakeChild implements ChildProcessLike {
  signals: string[] = [];
  private exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  private stdoutCb: ((c: string) => void) | null = null;
  private stderrCb: ((c: string) => void) | null = null;
  stdout = {
    on: (_e: 'data', cb: (c: Buffer | string) => void) => {
      this.stdoutCb = cb as (c: string) => void;
    },
  };
  stderr = {
    on: (_e: 'data', cb: (c: Buffer | string) => void) => {
      this.stderrCb = cb as (c: string) => void;
    },
  };
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    return true;
  }
  on(event: string, cb: never) {
    if (event === 'exit') this.exitCb = cb;
    return this;
  }
  exit(code: number | null = 1, signal: NodeJS.Signals | null = null) {
    this.exitCb?.(code, signal);
  }
  say(text: string, stream: 'out' | 'err' = 'out') {
    (stream === 'out' ? this.stdoutCb : this.stderrCb)?.(text);
  }
}

function setup(over: Partial<SupervisorOptions> = {}) {
  let now = 1_000_000;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let nextId = 1;
  const spawned: { name: string; child: FakeChild }[] = [];
  const out: string[] = [];
  const logs: string[] = [];
  const specs: ChildSpec[] = [
    { name: 'web', command: 'node', args: ['web'], env: {} },
    { name: 'worker', command: 'node', args: ['worker'], env: {} },
  ];
  let stoppedSteps = 0;
  const sup = new Supervisor({
    specs,
    spawn: (spec) => {
      const child = new FakeChild();
      spawned.push({ name: spec.name, child });
      return child;
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { id: nextId++, at: now + ms, fn };
      timers.push(t);
      return t.id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    log: createLogger({ write: (l) => logs.push(l) }),
    write: (l) => out.push(l),
    onStopped: () => {
      stoppedSteps += 1;
    },
    ...over,
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = end;
  };
  const running = (name: string) => spawned.filter((s) => s.name === name);
  return {
    sup,
    advance,
    spawned,
    running,
    out,
    logs,
    stopped: () => stoppedSteps,
    setNow: (n: number) => (now = n),
    now: () => now,
  };
}

describe('supervisor', () => {
  it('starts both children', () => {
    const t = setup();
    t.sup.start();
    expect(t.spawned.map((s) => s.name)).toEqual(['web', 'worker']);
  });

  it('restarts a crashed child after a growing pause, and leaves the other alone', () => {
    const t = setup();
    t.sup.start();
    t.running('web')[0]?.child.exit(1);
    expect(t.running('web')).toHaveLength(1); // not yet: it waits
    t.advance(999);
    expect(t.running('web')).toHaveLength(1);
    t.advance(2);
    expect(t.running('web')).toHaveLength(2);
    t.running('web')[1]?.child.exit(1);
    t.advance(1999);
    expect(t.running('web')).toHaveLength(2);
    t.advance(2);
    expect(t.running('web')).toHaveLength(3); // 2 s the second time
    expect(t.running('worker')).toHaveLength(1);
  });

  it('a child that exits with code 0 is also restarted (they should never stop by themselves)', () => {
    const t = setup();
    t.sup.start();
    t.running('worker')[0]?.child.exit(0);
    t.advance(1100);
    expect(t.running('worker')).toHaveLength(2);
  });

  it('a crash loop is bounded: it stops everything and exits 1 so the platform restarts the container', async () => {
    const t = setup();
    t.sup.start();
    for (let i = 0; i < 5; i++) {
      const w = t.running('web');
      w[w.length - 1]?.child.exit(1);
      t.advance(40_000);
    }
    expect(t.running('web').length).toBeLessThanOrEqual(5);
    // the worker was told to stop
    expect(t.running('worker')[0]?.child.signals).toContain('SIGTERM');
    t.running('worker')[0]?.child.exit(0, 'SIGTERM');
    expect(await t.sup.done).toBe(1);
    expect(t.stopped()).toBe(1);
    expect(t.logs.join('\n')).toContain('supervisor.giving_up');
  });

  it('crashes spread out over time are forgiven', () => {
    const t = setup();
    t.sup.start();
    for (let i = 0; i < 12; i++) {
      const w = t.running('web');
      w[w.length - 1]?.child.exit(1);
      t.advance(6 * 60_000); // longer than the 5 minute window
    }
    expect(t.running('web')).toHaveLength(13); // still being restarted
  });

  it('SIGTERM: both children are told to stop, and the exit code is 0 once both are gone', async () => {
    const t = setup();
    t.sup.start();
    t.sup.requestStop();
    expect(t.running('web')[0]?.child.signals).toEqual(['SIGTERM']);
    expect(t.running('worker')[0]?.child.signals).toEqual(['SIGTERM']);
    t.running('worker')[0]?.child.exit(0, 'SIGTERM');
    t.running('web')[0]?.child.exit(0, 'SIGTERM');
    expect(await t.sup.done).toBe(0);
    expect(t.stopped()).toBe(1); // the final step (checkpoint) ran exactly once
  });

  it('a child that ignores SIGTERM is killed after the grace period', async () => {
    const t = setup({ graceMs: 5000 });
    t.sup.start();
    t.sup.requestStop();
    t.advance(4999);
    expect(t.running('worker')[0]?.child.signals).toEqual(['SIGTERM']);
    t.advance(2);
    expect(t.running('worker')[0]?.child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    t.running('worker')[0]?.child.exit(null, 'SIGKILL');
    t.running('web')[0]?.child.exit(null, 'SIGKILL');
    expect(await t.sup.done).toBe(0);
  });

  it('an exit during shutdown is not a crash, and a pending restart is cancelled', async () => {
    const t = setup();
    t.sup.start();
    t.running('web')[0]?.child.exit(1); // restart is scheduled
    t.sup.requestStop();
    t.advance(60_000);
    expect(t.running('web')).toHaveLength(1); // never restarted
    t.running('worker')[0]?.child.exit(0, 'SIGTERM');
    expect(await t.sup.done).toBe(0);
  });

  it('asking to stop twice does nothing the second time', () => {
    const t = setup();
    t.sup.start();
    t.sup.requestStop();
    t.sup.requestStop();
    expect(t.running('web')[0]?.child.signals).toEqual(['SIGTERM']);
  });

  it('stops at once when no child is running', async () => {
    const t = setup();
    t.sup.start();
    t.running('web')[0]?.child.exit(1);
    t.running('worker')[0]?.child.exit(1);
    t.sup.requestStop();
    expect(await t.sup.done).toBe(0);
  });

  it('a final step that throws does not stop the exit', async () => {
    const t = setup({
      onStopped: () => {
        throw new Error('checkpoint failed');
      },
    });
    t.sup.start();
    t.sup.requestStop();
    t.running('web')[0]?.child.exit(0);
    t.running('worker')[0]?.child.exit(0);
    expect(await t.sup.done).toBe(0);
    expect(t.logs.join('\n')).toContain('supervisor.final_step_failed');
  });

  it('a process that cannot even be started counts as a crash (bounded)', async () => {
    let calls = 0;
    const t = setup({
      spawn: () => {
        calls += 1;
        throw new Error('ENOENT /secret/path');
      },
    });
    t.sup.start();
    for (let i = 0; i < 10; i++) t.advance(40_000);
    expect(await t.sup.done).toBe(1);
    expect(calls).toBeLessThan(15);
    expect(t.logs.join('\n')).not.toContain('/secret/path');
  });
});

describe('hung worker', () => {
  const hb = (age: () => number | null) => ({
    childName: 'worker',
    ageMs: age,
    maxAgeMs: 300_000,
    checkEveryMs: 30_000,
    startupGraceMs: 60_000,
  });

  it('a worker with no sign of life for too long is killed and restarted', () => {
    let age: number | null = 10_000;
    const t = setup({ heartbeat: hb(() => age) });
    t.sup.start();
    t.advance(120_000);
    expect(t.running('worker')[0]?.child.signals).toEqual([]); // healthy
    age = 400_000;
    t.advance(30_000);
    expect(t.running('worker')[0]?.child.signals).toEqual(['SIGKILL']);
    t.running('worker')[0]?.child.exit(null, 'SIGKILL');
    t.advance(1100);
    expect(t.running('worker')).toHaveLength(2);
  });

  it('a missing heartbeat counts too, but a new worker gets a start-up grace', () => {
    const t = setup({ heartbeat: hb(() => null) });
    t.sup.start();
    t.advance(30_000);
    expect(t.running('worker')[0]?.child.signals).toEqual([]); // still starting
    t.advance(60_000);
    expect(t.running('worker')[0]?.child.signals).toEqual(['SIGKILL']);
  });

  it('only the worker is watched, not the web server', () => {
    const t = setup({ heartbeat: hb(() => null) });
    t.sup.start();
    t.advance(200_000);
    expect(t.running('web')[0]?.child.signals).toEqual([]);
  });
});

describe('what the children print', () => {
  it('is redacted before it leaves, and plain text is wrapped as a JSON line', () => {
    const secret = 'sup3r-s3cret-value-1234';
    const t = setup({ secrets: [secret] });
    t.sup.start();
    const web = t.running('web')[0]?.child;
    web?.say(`started with ${secret} at https://user:pw@host.example/path?x=1\nsecond line\n`);
    web?.say('Authorization: Bearer abcdefgh12345678\n', 'err');
    const text = t.out.join('\n');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('user:pw');
    expect(text).not.toContain('abcdefgh12345678');
    const first = JSON.parse(t.out[0] as string);
    expect(first).toMatchObject({ service: 'web', event: 'output', level: 'info' });
    expect(JSON.parse(t.out[2] as string)).toMatchObject({ level: 'warn' });
  });

  it('lines of our own JSON log pass through (redacted), partial lines are joined', () => {
    const t = setup();
    t.sup.start();
    const worker = t.running('worker')[0]?.child;
    worker?.say('{"ts":"2026-01-01","level":"info","service":"worker","ev');
    worker?.say('ent":"backup.ok","bytes":5}\n');
    expect(t.out).toEqual([
      '{"ts":"2026-01-01","level":"info","service":"worker","event":"backup.ok","bytes":5}',
    ]);
  });
});
