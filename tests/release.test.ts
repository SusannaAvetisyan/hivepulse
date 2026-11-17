import { describe, expect, it } from 'vitest';
import { HandlerAlreadyRegisteredError, HivePulse } from '../src/index.js';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('release requirements', () => {
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid concurrency %s', concurrency => {
    expect(() => new HivePulse({ concurrency })).toThrow(RangeError);
  });

  it('rejects duplicate handlers and preserves the original', async () => {
    const engine = new HivePulse();
    engine.register('work', () => 1);
    expect(() => engine.register('work', () => 2)).toThrow(HandlerAlreadyRegisteredError);
    const id = engine.add({ type: 'work', context: null });
    await engine.onIdle();
    expect(engine.getJob(id)?.result).toBe(1);
  });

  it('returns isolated snapshots including nested payloads and dates', async () => {
    const engine = new HivePulse();
    engine.register('work', () => ({ nested: { value: 1 } }));
    const id = engine.add({ type: 'work', context: { nested: { value: 1 } }, properties: { nested: { value: 1 } } });
    const waiting = engine.getJob(id)!;
    waiting.status = 'failed';
    waiting.createdAt.setTime(0);
    (waiting.context as { nested: { value: number } }).nested.value = 9;
    (waiting.properties.nested as { value: number }).value = 9;
    expect(engine.getJob(id)?.status).toBe('waiting');
    expect(engine.getJob(id)?.createdAt.getTime()).toBeGreaterThan(0);
    expect(engine.getJob(id)?.context).toEqual({ nested: { value: 1 } });
    expect(engine.getJob(id)?.properties).toEqual({ nested: { value: 1 } });
    await engine.onIdle();
    expect(waiting.status).toBe('failed');
    const completed = engine.getJob(id)!;
    (completed.result as { nested: { value: number } }).nested.value = 9;
    expect(engine.getJob(id)?.result).toEqual({ nested: { value: 1 } });
  });

  it('isolates errors and their nested causes', async () => {
    const engine = new HivePulse();
    engine.register('work', () => { throw new Error('failure', { cause: { value: 1 } }); });
    const id = engine.add({ type: 'work', context: null });
    await engine.onIdle();
    const error = engine.getJob(id)!.error!;
    error.message = 'changed';
    (error.cause as { value: number }).value = 9;
    expect(engine.getJob(id)?.error?.message).toBe('failure');
    expect(engine.getJob(id)?.error?.cause).toEqual({ value: 1 });
  });

  it('resolves immediately when empty and supports repeated idle cycles', async () => {
    const engine = new HivePulse();
    await engine.onIdle();
    await engine.onIdle();
    engine.register('work', (n: number) => n * 2);
    for (const context of [1, 2]) {
      const id = engine.add({ type: 'work', context });
      await engine.onIdle();
      expect(engine.getJob(id)).toMatchObject({ status: 'completed', result: context * 2 });
    }
  });

  it('waits for queued and active jobs, including failures and concurrent waiters', async () => {
    const engine = new HivePulse();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    engine.register('work', async (n: number) => {
      if (n === 1) await gate;
      if (n === 2) throw new Error('expected');
      return n;
    });
    const ids = [1, 2, 3].map(context => engine.add({ type: 'work', context }));
    let idle = false;
    const first = engine.onIdle().then(() => { idle = true; });
    const second = engine.onIdle();
    try {
      await settle();
      expect(idle).toBe(false);
      expect(engine.getJob(ids[2]!)?.status).toBe('waiting');
    } finally { release(); }
    await Promise.all([first, second]);
    expect(ids.map(id => engine.getJob(id)?.status)).toEqual(['completed', 'failed', 'completed']);
  });

  it('handles a 1000-job burst with mixed outcomes and bounded concurrency', async () => {
    const engine = new HivePulse({ concurrency: 3 });
    const order: number[] = [];
    let running = 0;
    let peak = 0;
    engine.register('work', (n: number) => {
      order.push(n);
      if (n % 11 === 0) throw new Error('synchronous');
      running++;
      peak = Math.max(peak, running);
      return Promise.resolve().then(() => {
        if (n % 7 === 0) throw new Error('asynchronous');
        return n;
      }).finally(() => { running--; });
    });
    const ids = Array.from({ length: 1000 }, (_, context) => engine.add({ type: 'work', context }));
    await engine.onIdle();
    expect(order).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(peak).toBe(3);
    expect(running).toBe(0);
    ids.forEach((id, n) => {
      expect(engine.getJob(id)).toMatchObject({ attempts: 1, status: n % 11 === 0 || n % 7 === 0 ? 'failed' : 'completed' });
      if (n % 11 !== 0 && n % 7 !== 0) expect(engine.getJob(id)?.result).toBe(n);
    });
  });
});
