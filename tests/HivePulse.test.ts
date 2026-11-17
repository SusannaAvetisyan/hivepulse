import { describe, expect, it } from 'vitest';
import { HandlerNotRegisteredError, HivePulse } from '../src/index.js';

describe('unknown handlers', () => {
  it('throws a specific error synchronously with the missing job type', () => {
    const engine = new HivePulse();
    const submit = () => engine.add({ type: 'send-email', context: {} });

    expect(submit).toThrow(HandlerNotRegisteredError);
    expect(submit).toThrow('send-email');
    try {
      submit();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'HandlerNotRegisteredError',
        jobType: 'send-email',
      });
    }
  });

  it('still accepts registered types and stores the job', () => {
    const engine = new HivePulse();
    engine.register('echo', async (context: string) => context);
    const id = engine.add({ type: 'echo', context: 'hello' });
    expect(engine.getJob(id)).toMatchObject({ id, type: 'echo', status: 'waiting' });
  });
});


// Yield one event-loop turn so queued microtasks settle; no timed sleeps.
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('execution', () => {
  it('returns the job ID before invoking the handler', async () => {
    const engine = new HivePulse();
    let started = false;
    engine.register('work', async () => { started = true; });
    const id = engine.add({ type: 'work', context: null });
    expect(typeof id).toBe('string');
    expect(started).toBe(false);
    expect(engine.getJob(id)?.status).toBe('waiting');
    await settle();
    expect(started).toBe(true);
    expect(engine.getJob(id)?.status).toBe('completed');
  });

  it('records context, result, timestamps, and one attempt through the lifecycle', async () => {
    const engine = new HivePulse();
    const gate = deferred();
    const context = { value: 7 };
    let received: unknown;
    engine.register('double', async (input: typeof context) => {
      received = input;
      await gate.promise;
      return input.value * 2;
    });
    const id = engine.add({ type: 'double', context, properties: { tenant: 'a' } });
    expect(engine.getJob(id)).toMatchObject({ id, status: 'waiting', attempts: 0, properties: { tenant: 'a' } });
    try {
      await settle();
      expect(received).toEqual(context);
      expect(engine.getJob(id)).toMatchObject({ status: 'active', attempts: 1 });
      expect(engine.getJob(id)?.startedAt).toBeInstanceOf(Date);
      expect(engine.getJob(id)?.finishedAt).toBeUndefined();
    } finally { gate.resolve(); await settle(); }
    const job = engine.getJob(id)!;
    expect(job).toMatchObject({ id, status: 'completed', result: 14, attempts: 1 });
    expect(job.error).toBeUndefined();
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.finishedAt).toBeInstanceOf(Date);
    expect(job.startedAt!.getTime()).toBeGreaterThanOrEqual(job.createdAt.getTime());
    expect(job.finishedAt!.getTime()).toBeGreaterThanOrEqual(job.startedAt!.getTime());
    expect(engine.getJob('missing')).toBeUndefined();
  });

  it('starts queued jobs in FIFO order with default concurrency one', async () => {
    const engine = new HivePulse();
    const gate = deferred();
    const order: number[] = [];
    engine.register('work', async (n: number) => {
      order.push(n);
      if (n === 1) await gate.promise;
      return n;
    });
    const ids = [1, 2, 3, 4].map(context => engine.add({ type: 'work', context }));
    try {
      await settle();
      expect(order).toEqual([1]);
      expect(engine.getJob(ids[1]!)?.status).toBe('waiting');
    } finally { gate.resolve(); await settle(); }
    expect(order).toEqual([1, 2, 3, 4]);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(engine.getJob(id)?.status).toBe('completed');
  });

  it('fills available slots, respects the limit, and refills when any job finishes', async () => {
    const engine = new HivePulse({ concurrency: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const order: number[] = [];
    let running = 0;
    let peak = 0;
    engine.register('work', async (n: number) => {
      order.push(n);
      running++;
      peak = Math.max(peak, running);
      try { await gates[n]!.promise; } finally { running--; }
    });
    const ids = gates.map((_, context) => engine.add({ type: 'work', context }));
    try {
      await settle();
      expect(order).toEqual([0, 1]);
      expect(running).toBe(2);
      expect(engine.getJob(ids[2]!)?.status).toBe('waiting');
      gates[1]!.resolve();
      await settle();
      expect(order).toEqual([0, 1, 2]);
      expect(engine.getJob(ids[0]!)?.status).toBe('active');
      expect(running).toBe(2);
      gates[2]!.resolve();
      await settle();
      expect(order).toEqual([0, 1, 2, 3]);
    } finally {
      gates.forEach(gate => gate.resolve());
      await settle();
    }
    expect(peak).toBe(2);
    expect(running).toBe(0);
    for (const id of ids) expect(engine.getJob(id)?.status).toBe('completed');
  });

  it.each(['sync', 'async'] as const)('records a %s failure and continues queued work', async mode => {
    const engine = new HivePulse();
    const failure = new Error('handler failed');
    engine.register('work', (n: number) => {
      if (n === 1) {
        if (mode === 'sync') throw failure;
        return Promise.reject(failure);
      }
      return Promise.resolve(n);
    });
    const first = engine.add({ type: 'work', context: 1 });
    const next = engine.add({ type: 'work', context: 2 });
    await settle();
    const job = engine.getJob(first)!;
    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    expect(job.error).toBeInstanceOf(Error);
    expect(job.error?.message).toBe(failure.message);
    expect(job.result).toBeUndefined();
    expect(job.startedAt).toBeInstanceOf(Date);
    expect(job.finishedAt).toBeInstanceOf(Date);
    expect(engine.getJob(next)).toMatchObject({ status: 'completed', result: 2, attempts: 1 });
  });

  it.each(['broken', null, undefined, 42, { reason: 'failure' }])('normalizes rejection value %j into an Error', async reason => {
    const engine = new HivePulse();
    engine.register('fail', async () => { throw reason; });
    const id = engine.add({ type: 'fail', context: null });
    await settle();
    expect(engine.getJob(id)?.status).toBe('failed');
    expect(engine.getJob(id)?.error).toBeInstanceOf(Error);
    expect(engine.getJob(id)?.error?.cause).toEqual(reason);
  });

  it('preserves FIFO when the first handler in a concurrent batch throws synchronously', async () => {
    const engine = new HivePulse({ concurrency: 2 });
    const order: number[] = [];
    engine.register('work', (n: number) => {
      order.push(n);
      if (n === 1) throw new Error('synchronous failure');
      return Promise.resolve(n);
    });
    const ids = [1, 2, 3].map(context => engine.add({ type: 'work', context }));
    await settle();
    expect(order).toEqual([1, 2, 3]);
    expect(ids.map(id => engine.getJob(id)?.status)).toEqual(['failed', 'completed', 'completed']);
  });
});
