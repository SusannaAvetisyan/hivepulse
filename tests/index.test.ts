import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { VERSION, type JobHandler } from '../src/index.js';

describe('public entry point', () => {
  it('exports the package version', () => {
    const metadata = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(metadata.version);
  });

  it('exposes a typed asynchronous job handler', async () => {
    const handler: JobHandler<{ value: number }, number> = async ({ value }) => value * 2;
    expectTypeOf(handler).parameter(0).toEqualTypeOf<{ value: number }>();
    expectTypeOf(handler).returns.toEqualTypeOf<Promise<number> | number>();
    await expect(handler({ value: 3 })).resolves.toBe(6);
  });
});
