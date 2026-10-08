import 'server-only';
import {
  CRASH_POLICY,
  decideAfterCrash,
  type CrashPolicy,
} from '@/domain/hosting/supervisor-policy';
import { redactText } from '@/domain/hosting/redact';
import type { Logger } from './logger';

/**
 * A tiny supervisor for ONE container that runs two processes: the web server and the worker.
 *
 * - A child that exits (for any reason, even code 0: they should never stop by themselves) is
 *   restarted after a growing pause.
 * - A child that keeps crashing (5 times in 5 minutes) makes the supervisor stop everything and exit
 *   with code 1, so the platform restarts the whole container.
 * - On SIGTERM (a deploy or a stop) both children get SIGTERM, so the worker can finish the delivery
 *   it is in, and the web server its open requests. Whoever is still running after the grace period
 *   is killed. Then the optional `onStopped` step (a final database checkpoint) runs, and the exit
 *   code is 0.
 * - If the worker shows no sign of life for too long, it is killed and restarted (a hung process).
 * - Everything the children print passes through the redactor first.
 *
 * Time, spawning and timers are injected so all of this is tested without real processes.
 */

export interface ChildSpec {
  name: string;
  command: string;
  args: readonly string[];
  env: Record<string, string | undefined>;
}

export interface ChildProcessLike {
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', cb: (error: Error) => void): unknown;
  stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
}

export interface SupervisorOptions {
  specs: readonly ChildSpec[];
  spawn: (spec: ChildSpec) => ChildProcessLike;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  log: Logger;
  /** Where child output lines go (one JSON object per line). */
  write: (line: string) => void;
  secrets?: readonly string[];
  policy?: CrashPolicy;
  /** Time children get after SIGTERM before they are killed. */
  graceMs?: number;
  heartbeat?: {
    childName: string;
    /** Age of the worker's last sign of life in ms, or null if there is none. */
    ageMs: () => number | null;
    maxAgeMs: number;
    checkEveryMs: number;
    /** A freshly started child gets this long before its silence counts. */
    startupGraceMs: number;
  };
  /** Runs once after every child has stopped (for example a final database checkpoint). */
  onStopped?: () => Promise<void> | void;
}

interface Child {
  spec: ChildSpec;
  proc: ChildProcessLike | null;
  crashes: number[];
  startedAt: number;
  restartTimer: unknown;
  /** Already killed for a silent heartbeat; waiting for its exit. */
  killedForSilence: boolean;
}

export class Supervisor {
  private readonly children: Child[];
  private stopping = false;
  private exitCode = 0;
  private graceTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private finished = false;
  private resolveDone!: (code: number) => void;
  /** Resolves with the exit code once everything has stopped. */
  readonly done: Promise<number>;

  constructor(private readonly o: SupervisorOptions) {
    this.children = o.specs.map((spec) => ({
      spec,
      proc: null,
      crashes: [],
      startedAt: 0,
      restartTimer: null,
      killedForSilence: false,
    }));
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  start(): void {
    for (const c of this.children) this.launch(c);
    const hb = this.o.heartbeat;
    if (hb) {
      const tick = () => {
        this.heartbeatTimer = this.o.setTimer(tick, hb.checkEveryMs);
        this.checkHeartbeat();
      };
      this.heartbeatTimer = this.o.setTimer(tick, hb.checkEveryMs);
    }
  }

  /** A deploy or a stop (SIGTERM / SIGINT). */
  requestStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.o.log.info('supervisor.stopping', {});
    this.terminateAll();
  }

  private launch(c: Child): void {
    c.restartTimer = null;
    c.killedForSilence = false;
    let proc: ChildProcessLike;
    try {
      proc = this.o.spawn(c.spec);
    } catch {
      // the process could not even be started: count it like a crash
      c.proc = null;
      this.onCrash(c, null, null);
      return;
    }
    c.proc = proc;
    c.startedAt = this.o.now();
    this.pipe(c, proc.stdout, 'info');
    this.pipe(c, proc.stderr, 'warn');
    proc.on('error', () => undefined); // an 'exit' event follows; the message could hold a path
    proc.on('exit', (code, signal) => {
      if (c.proc !== proc) return;
      c.proc = null;
      this.onExit(c, code, signal);
    });
    this.o.log.info('child.started', { child: c.spec.name });
  }

  private pipe(c: Child, stream: ChildProcessLike['stdout'], level: 'info' | 'warn'): void {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        this.emit(c.spec.name, level, buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
      if (buffer.length > 8192) {
        this.emit(c.spec.name, level, buffer);
        buffer = '';
      }
    });
  }

  private emit(child: string, level: string, raw: string): void {
    const line = redactText(raw.trim(), this.o.secrets ?? []);
    if (line === '') return;
    // our own log lines are already JSON: pass them on; anything else is wrapped
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { event?: unknown }).event === 'string'
      ) {
        this.o.write(line);
        return;
      }
    } catch {
      /* not JSON */
    }
    this.o.write(
      JSON.stringify({
        ts: new Date(this.o.now()).toISOString(),
        level,
        service: child,
        event: 'output',
        line,
      }),
    );
  }

  private onExit(c: Child, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopping) {
      this.maybeFinish();
      return;
    }
    this.onCrash(c, code, signal);
  }

  private onCrash(c: Child, code: number | null, signal: NodeJS.Signals | null): void {
    const result = decideAfterCrash(c.crashes, this.o.now(), this.o.policy ?? CRASH_POLICY);
    c.crashes = result.crashTimes;
    this.o.log.error('child.crashed', {
      child: c.spec.name,
      code,
      signal,
      crashesInWindow: c.crashes.length,
    });
    if (result.decision.action === 'give_up') {
      this.o.log.error('supervisor.giving_up', { child: c.spec.name });
      this.exitCode = 1;
      this.stopping = true;
      this.terminateAll();
      return;
    }
    c.restartTimer = this.o.setTimer(() => {
      if (!this.stopping) this.launch(c);
    }, result.decision.delayMs);
  }

  private terminateAll(): void {
    for (const c of this.children) {
      if (c.restartTimer !== null) {
        this.o.clearTimer(c.restartTimer);
        c.restartTimer = null;
      }
      c.proc?.kill('SIGTERM');
    }
    if (this.heartbeatTimer !== null) {
      this.o.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.children.some((c) => c.proc)) {
      this.graceTimer = this.o.setTimer(() => {
        for (const c of this.children) {
          if (c.proc) {
            this.o.log.warn('child.killed_after_grace', { child: c.spec.name });
            c.proc.kill('SIGKILL');
          }
        }
      }, this.o.graceMs ?? 20_000);
    }
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (!this.stopping || this.finished || this.children.some((c) => c.proc)) return;
    this.finished = true;
    if (this.graceTimer !== null) this.o.clearTimer(this.graceTimer);
    void (async () => {
      try {
        await this.o.onStopped?.();
      } catch {
        this.o.log.error('supervisor.final_step_failed', {});
      }
      this.o.log.info('supervisor.stopped', { exitCode: this.exitCode });
      this.resolveDone(this.exitCode);
    })();
  }

  private checkHeartbeat(): void {
    const hb = this.o.heartbeat;
    if (!hb || this.stopping) return;
    const c = this.children.find((x) => x.spec.name === hb.childName);
    if (!c?.proc || c.killedForSilence) return;
    if (this.o.now() - c.startedAt < hb.startupGraceMs) return;
    const age = hb.ageMs();
    if (age === null || age > hb.maxAgeMs) {
      this.o.log.error('child.heartbeat_stale', { child: c.spec.name });
      c.killedForSilence = true;
      c.proc.kill('SIGKILL'); // the exit that follows is handled as a crash: restart, or give up if it repeats
    }
  }
}
