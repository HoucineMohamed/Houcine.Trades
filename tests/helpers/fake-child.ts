import type { ChildProcessLike } from '@/hosting/supervisor';

/** A pretend child process: records signals, lets a test make it exit or print. */
export class FakeChild implements ChildProcessLike {
  signals: string[] = [];
  /** A started process has a pid; a process that failed to start has none. */
  pid: number | undefined = 4242;
  private errorCb: ((e: Error) => void) | null = null;
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
    if (event === 'error') this.errorCb = cb;
    return this;
  }
  /** The process could not be started: Node emits only 'error', never 'exit'. */
  failToStart() {
    this.pid = undefined;
    this.errorCb?.(new Error('spawn ENOENT /secret/path'));
  }
  exit(code: number | null = 1, signal: NodeJS.Signals | null = null) {
    this.exitCb?.(code, signal);
  }
  say(text: string, stream: 'out' | 'err' = 'out') {
    (stream === 'out' ? this.stdoutCb : this.stderrCb)?.(text);
  }
}

/** A manual clock and timer list: nothing waits for real time. */
export function fakeTime(start = 1_000_000) {
  let now = start;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { id: nextId++, at: now + ms, fn };
      timers.push(t);
      return t.id as unknown;
    },
    clearTimer: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    advance: (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = Math.max(now, due.at);
        due.fn();
      }
      now = end;
    },
    pending: () => timers.length,
  };
}
